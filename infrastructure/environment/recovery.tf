# Recovery records survive restoring PostgreSQL. No runtime identity may
# overwrite or delete one. This is separate from the 30-day source-body bucket.
resource "google_storage_bucket" "recovery" {
  name                        = "${var.project_id}-lexcerta-recovery"
  location                    = local.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels
  versioning { enabled = false }
  soft_delete_policy { retention_duration_seconds = 0 }
  # No automatic deletion until record retention and isolated replay qualify.
  # In particular, source-removal restrictions must outlive cached body expiry.
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.api]
}

resource "google_project_iam_custom_role" "recovery_append" {
  role_id     = "lexcerta_recovery_append"
  title       = "LexCerta immutable recovery records"
  permissions = ["storage.objects.create", "storage.objects.get"]
  depends_on  = [google_project_service.api]
}

resource "google_storage_bucket_iam_member" "recovery_append" {
  bucket = google_storage_bucket.recovery.name
  role   = google_project_iam_custom_role.recovery_append.name
  member = "serviceAccount:${google_service_account.identity["operator"].email}"
  condition {
    title      = "environment_restrictions_only"
    expression = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.recovery.name}/objects/restrictions/v1/${var.environment}/')"
  }
}
