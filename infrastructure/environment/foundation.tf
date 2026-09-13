resource "google_project_service" "api" {
  for_each = toset([
    "artifactregistry.googleapis.com", "cloudresourcemanager.googleapis.com",
    "cloudscheduler.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com",
    "logging.googleapis.com", "monitoring.googleapis.com", "run.googleapis.com",
    "secretmanager.googleapis.com", "storage.googleapis.com", "sts.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}

resource "google_service_account" "identity" {
  for_each     = setunion(local.runtime_roles, toset(["scheduler", "operator-invoker", "release"]))
  account_id   = "lexcerta-${each.key}"
  display_name = "LexCerta ${var.environment} ${each.key}"
  depends_on   = [google_project_service.api]
}

resource "google_secret_manager_secret" "runtime" {
  for_each  = local.secret_readers
  secret_id = "lexcerta-${replace(each.key, "_", "-")}"
  labels    = local.labels
  replication {
    user_managed {
      replicas { location = local.region }
    }
  }
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.api]
}

resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = local.secret_grants
  secret_id = google_secret_manager_secret.runtime[each.value.secret].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.identity[each.value.reader].email}"
}

resource "google_storage_bucket" "sources" {
  name                        = "${var.project_id}-lexcerta-sources"
  location                    = local.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels
  versioning { enabled = false }
  soft_delete_policy { retention_duration_seconds = 0 }
  lifecycle_rule {
    action { type = "Delete" }
    condition {
      age            = 30
      matches_prefix = ["opinions/"]
    }
  }
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.api]
}

resource "google_project_iam_custom_role" "source_objects" {
  for_each = {
    public = ["storage.objects.get", "storage.objects.create", "storage.objects.delete"]
    job    = ["storage.objects.get", "storage.objects.delete"]
  }
  role_id     = "lexcerta_${each.key}_objects"
  title       = "LexCerta ${each.key} source objects"
  permissions = each.value
  depends_on  = [google_project_service.api]
}

resource "google_storage_bucket_iam_member" "source_objects" {
  for_each = google_project_iam_custom_role.source_objects
  bucket   = google_storage_bucket.sources.name
  role     = each.value.name
  member   = "serviceAccount:${google_service_account.identity[each.key].email}"
  condition {
    title      = "opinion_objects_only"
    expression = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.sources.name}/objects/opinions/')"
  }
}

resource "google_project_iam_custom_role" "source_listing" {
  role_id     = "lexcerta_source_listing"
  title       = "LexCerta maintenance source listing"
  permissions = ["storage.objects.list"]
  depends_on  = [google_project_service.api]
}

# Object-name conditions cannot constrain list requests. This dedicated bucket
# contains opinion bodies only; only maintenance receives bucket listing.
resource "google_storage_bucket_iam_member" "source_listing" {
  bucket = google_storage_bucket.sources.name
  role   = google_project_iam_custom_role.source_listing.name
  member = "serviceAccount:${google_service_account.identity["job"].email}"
}

resource "google_artifact_registry_repository" "runtime" {
  location      = local.region
  repository_id = "lexcerta"
  format        = "DOCKER"
  labels        = local.labels
  docker_config { immutable_tags = true }
  # Release/rollback images must remain available. Retention is a reviewed
  # release action until the delivery workflow can protect eligible digests.
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.api]
}

resource "google_service_account_iam_member" "human_operator" {
  for_each           = var.operator_members
  service_account_id = google_service_account.identity["operator-invoker"].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = each.key
}
