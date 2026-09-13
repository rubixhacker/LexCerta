output "project_number" { value = data.google_project.current.number }
output "service_accounts" { value = { for purpose, identity in google_service_account.identity : purpose => identity.email } }
output "secret_names" { value = { for purpose, secret in google_secret_manager_secret.runtime : purpose => secret.id } }
output "operator_url" { value = var.release == null ? null : local.operator_url }
output "public_url" { value = var.release == null ? null : local.public_url }
output "workload_identity_provider" { value = google_iam_workload_identity_pool_provider.github.name }
output "image_repository" { value = "${local.region}-docker.pkg.dev/${var.project_id}/lexcerta/runtime" }
output "workload_log_exclusion_filter" { value = local.workload_logs }
