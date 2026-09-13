locals {
  services = var.release == null ? {} : {
    public = {
      memory  = "1Gi", concurrency = 8, maximum = 3, timeout = "60s"
      command = "public-main.js"
      secrets = { LEXCERTA_DATABASE_PASSWORD = "database_public", API_KEY_PEPPER = "api_key_pepper", COURTLISTENER_API_TOKEN = "courtlistener" }
      env     = { COURTLISTENER_CREDENTIAL_ID = var.release.courtlistener_credential_id }
    }
    operator = {
      memory  = "512Mi", concurrency = 2, maximum = 1, timeout = "15s"
      command = "operator-main.js"
      secrets = { LEXCERTA_DATABASE_PASSWORD = "database_operator", API_KEY_PEPPER = "api_key_pepper" }
      env = {
        LEXCERTA_OPERATOR_AUDIENCE = local.operator_url
        LEXCERTA_OPERATOR_SUBJECTS = google_service_account.identity["operator-invoker"].unique_id
        LEXCERTA_PILOT_CUSTOMERS   = join(",", sort(tolist(var.release.pilot_customers)))
      }
    }
  }
  jobs = var.release == null ? {} : {
    job      = { name = "maintenance", command = "maintenance-main.js", timeout = "600s", retries = 1, secret = "database_job" }
    migrator = { name = "migrate", command = "migration-main.js", timeout = "120s", retries = 0, secret = "database_migrator" }
  }
  common_environment = var.release == null ? {} : {
    LEXCERTA_ENVIRONMENT   = var.environment
    GOOGLE_CLOUD_PROJECT   = var.project_id
    LEXCERTA_BUILD_ID      = var.release.build_id
    LEXCERTA_DATABASE_HOST = var.release.neon_host
  }
}

resource "google_cloud_run_v2_service" "runtime" {
  for_each             = local.services
  name                 = "lexcerta-${each.key}"
  location             = local.region
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = false
  deletion_protection  = true
  labels               = local.labels
  custom_audiences     = each.key == "operator" ? [local.operator_url] : []
  scaling {
    min_instance_count = 0
    max_instance_count = each.value.maximum
  }
  template {
    service_account                  = google_service_account.identity[each.key].email
    timeout                          = each.value.timeout
    max_instance_request_concurrency = each.value.concurrency
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    session_affinity                 = false
    scaling {
      min_instance_count = 0
      max_instance_count = each.value.maximum
    }
    containers {
      image   = local.image
      command = ["node", "build/node/${each.value.command}"]
      ports { container_port = 8080 }
      resources {
        limits            = { cpu = "1", memory = each.value.memory }
        cpu_idle          = true
        startup_cpu_boost = false
      }
      startup_probe {
        http_get { path = "/healthz" }
        initial_delay_seconds = 0
        timeout_seconds       = 1
        period_seconds        = 2
        failure_threshold     = 10
      }
      dynamic "env" {
        for_each = merge(local.common_environment, each.value.env)
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = each.value.secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.runtime[env.value].secret_id
              version = var.release.secret_versions[env.value]
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.runtime, google_storage_bucket_iam_member.source_objects, google_logging_project_exclusion.workloads, google_logging_project_sink.events]
}

resource "google_cloud_run_v2_service_iam_member" "operator" {
  count    = var.release == null ? 0 : 1
  name     = google_cloud_run_v2_service.runtime["operator"].name
  location = local.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.identity["operator-invoker"].email}"
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.activate ? 1 : 0
  name     = google_cloud_run_v2_service.runtime["public"].name
  location = local.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Before public activation, owner canaries carry a Google ID token in
# X-Serverless-Authorization and the LexCerta key in Authorization.
resource "google_cloud_run_v2_service_iam_member" "public_canary" {
  count    = var.release == null ? 0 : 1
  name     = google_cloud_run_v2_service.runtime["public"].name
  location = local.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.identity["operator-invoker"].email}"
}

resource "google_cloud_run_v2_service_iam_member" "release" {
  for_each = local.services
  name     = google_cloud_run_v2_service.runtime[each.key].name
  location = local.region
  role     = google_project_iam_custom_role.release_update.name
  member   = "serviceAccount:${google_service_account.identity["release"].email}"
}

resource "google_cloud_run_v2_job" "runtime" {
  for_each            = local.jobs
  name                = "lexcerta-${each.value.name}"
  location            = local.region
  deletion_protection = true
  labels              = local.labels
  template {
    task_count  = 1
    parallelism = 1
    template {
      service_account       = google_service_account.identity[each.key].email
      timeout               = each.value.timeout
      max_retries           = each.value.retries
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
      containers {
        image   = local.image
        command = ["node", "build/node/${each.value.command}"]
        resources { limits = { cpu = "1", memory = "512Mi" } }
        dynamic "env" {
          for_each = local.common_environment
          content {
            name  = env.key
            value = env.value
          }
        }
        env {
          name = "LEXCERTA_DATABASE_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.runtime[each.value.secret].secret_id
              version = var.release.secret_versions[each.value.secret]
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.runtime, google_storage_bucket_iam_member.source_objects, google_storage_bucket_iam_member.source_listing, google_logging_project_exclusion.workloads, google_logging_project_sink.events]
}

resource "google_cloud_run_v2_job_iam_member" "scheduler" {
  count    = var.release == null ? 0 : 1
  name     = google_cloud_run_v2_job.runtime["job"].name
  location = local.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.identity["scheduler"].email}"
}

resource "google_cloud_run_v2_job_iam_member" "release" {
  for_each = local.jobs
  name     = google_cloud_run_v2_job.runtime[each.key].name
  location = local.region
  role     = google_project_iam_custom_role.release_update.name
  member   = "serviceAccount:${google_service_account.identity["release"].email}"
}

resource "google_cloud_scheduler_job" "maintenance" {
  count            = var.release == null ? 0 : 1
  name             = "lexcerta-maintenance"
  region           = local.region
  schedule         = "0 * * * *"
  time_zone        = "Etc/UTC"
  paused           = !var.activate
  attempt_deadline = "60s"
  retry_config {
    retry_count          = 1
    max_retry_duration   = "600s"
    min_backoff_duration = "60s"
    max_backoff_duration = "300s"
    max_doublings        = 2
  }
  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${local.region}/jobs/${google_cloud_run_v2_job.runtime["job"].name}:run"
    body        = base64encode("{}")
    headers     = { "Content-Type" = "application/json" }
    oauth_token {
      service_account_email = google_service_account.identity["scheduler"].email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }
  depends_on = [google_cloud_run_v2_job_iam_member.scheduler]
}
