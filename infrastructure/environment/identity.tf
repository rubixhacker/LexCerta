resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "lexcerta-github"
  display_name              = "LexCerta ${var.environment} release"
  depends_on                = [google_project_service.api]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "release"
  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
    "attribute.ref"                 = "assertion.ref"
    "attribute.workflow_ref"        = "assertion.workflow_ref"
  }
  # Numeric IDs verified against GitHub. A reused repository/owner name cannot
  # acquire this trust. The protected environment must also authorize the job.
  attribute_condition = join(" && ", [
    "assertion.repository_id == '1157346206'",
    "assertion.repository_owner_id == '1776138'",
    "assertion.ref == 'refs/heads/main'",
    "assertion.workflow_ref == 'rubixhacker/LexCerta/.github/workflows/release.yml@refs/heads/main'",
    "assertion.sub == 'repo:rubixhacker/LexCerta:environment:${var.environment}'",
  ])
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}

resource "google_service_account_iam_member" "github_release" {
  service_account_id = google_service_account.identity["release"].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/1157346206"
}

resource "google_service_account_iam_member" "release_runtime" {
  for_each           = local.runtime_roles
  service_account_id = google_service_account.identity[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.identity["release"].email}"
}

resource "google_artifact_registry_repository_iam_member" "release" {
  location   = google_artifact_registry_repository.runtime.location
  repository = google_artifact_registry_repository.runtime.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.identity["release"].email}"
}

resource "google_project_iam_custom_role" "release_update" {
  role_id     = "lexcerta_release_update"
  title       = "LexCerta existing workload release"
  permissions = ["run.services.update", "run.jobs.update", "run.jobs.run"]
  depends_on  = [google_project_service.api]
}

resource "google_project_iam_custom_role" "release_observe" {
  role_id = "lexcerta_release_observe"
  title   = "LexCerta release status"
  permissions = [
    "run.services.get", "run.jobs.get", "run.operations.get",
    "run.executions.get", "run.executions.list",
  ]
  depends_on = [google_project_service.api]
}

resource "google_project_iam_member" "release_observe" {
  project = var.project_id
  role    = google_project_iam_custom_role.release_observe.name
  member  = "serviceAccount:${google_service_account.identity["release"].email}"
}
