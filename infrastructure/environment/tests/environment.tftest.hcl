# Mocked provider only. These tests cannot provision resources or establish
# live IAM, query delivery, project isolation or production readiness.
mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
}

override_resource {
  target = google_service_account.identity["public"]
  values = {
    email     = "lexcerta-public@lexcerta-fixture-staging.iam.gserviceaccount.com"
    name      = "projects/lexcerta-fixture-staging/serviceAccounts/lexcerta-public@lexcerta-fixture-staging.iam.gserviceaccount.com"
    unique_id = "100000000000000000000"
  }
}

override_resource {
  target = google_service_account.identity["operator"]
  values = {
    email     = "lexcerta-operator@lexcerta-fixture-staging.iam.gserviceaccount.com"
    name      = "projects/lexcerta-fixture-staging/serviceAccounts/lexcerta-operator@lexcerta-fixture-staging.iam.gserviceaccount.com"
    unique_id = "100000000000000000001"
  }
}

override_resource {
  target = google_service_account.identity["job"]
  values = {
    email     = "lexcerta-job@lexcerta-fixture-staging.iam.gserviceaccount.com"
    name      = "projects/lexcerta-fixture-staging/serviceAccounts/lexcerta-job@lexcerta-fixture-staging.iam.gserviceaccount.com"
    unique_id = "100000000000000000002"
  }
}

override_resource {
  target = google_service_account.identity["migrator"]
  values = {
    email     = "lexcerta-migrator@lexcerta-fixture-staging.iam.gserviceaccount.com"
    name      = "projects/lexcerta-fixture-staging/serviceAccounts/lexcerta-migrator@lexcerta-fixture-staging.iam.gserviceaccount.com"
    unique_id = "100000000000000000003"
  }
}

override_resource {
  target = google_service_account.identity["scheduler"]
  values = {
    email     = "lexcerta-scheduler@lexcerta-fixture-staging.iam.gserviceaccount.com"
    name      = "projects/lexcerta-fixture-staging/serviceAccounts/lexcerta-scheduler@lexcerta-fixture-staging.iam.gserviceaccount.com"
    unique_id = "100000000000000000004"
  }
}

override_resource {
  target = google_service_account.identity["operator-invoker"]
  values = {
    email     = "lexcerta-operator-invoker@lexcerta-fixture-staging.iam.gserviceaccount.com"
    name      = "projects/lexcerta-fixture-staging/serviceAccounts/lexcerta-operator-invoker@lexcerta-fixture-staging.iam.gserviceaccount.com"
    unique_id = "100000000000000000005"
  }
}

override_resource {
  target = google_service_account.identity["release"]
  values = {
    email     = "lexcerta-release@lexcerta-fixture-staging.iam.gserviceaccount.com"
    name      = "projects/lexcerta-fixture-staging/serviceAccounts/lexcerta-release@lexcerta-fixture-staging.iam.gserviceaccount.com"
    unique_id = "100000000000000000006"
  }
}

variables {
  project_id            = "lexcerta-fixture-staging"
  environment           = "staging"
  operator_members      = ["user:owner@example.invalid"]
  notification_channels = ["projects/lexcerta-fixture-staging/notificationChannels/1234"]
  release = {
    image_digest                = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
    build_id                    = "1111111111111111111111111111111111111111"
    neon_host                   = "ep-fixture-alpha.us-east-2.aws.neon.tech"
    courtlistener_credential_id = "fixture-staging"
    pilot_customers             = ["fixture-one", "fixture-two", "fixture-three"]
    secret_versions = {
      database_public   = "2", database_operator = "3", database_job = "4",
      database_migrator = "5", api_key_pepper = "6", courtlistener = "7"
    }
  }
}

run "foundation_without_credentials_or_release" {
  command = apply
  variables { release = null }
  assert {
    condition     = length(google_cloud_run_v2_service.runtime) == 0 && length(google_cloud_run_v2_job.runtime) == 0 && length(google_cloud_scheduler_job.maintenance) == 0
    error_message = "Foundation must not start an unconfigured image or schedule work."
  }
  assert {
    condition     = length(google_secret_manager_secret.runtime) == 6 && length(google_secret_manager_secret_iam_member.runtime) == 7 && length(google_service_account.identity) == 7
    error_message = "Foundation must prepare separate identities and narrowly shared secret containers."
  }
  assert {
    condition     = !google_monitoring_alert_policy.maintenance_missing.enabled && !google_monitoring_alert_policy.maintenance_failed.enabled
    error_message = "An empty foundation must not generate missing-job incidents."
  }
}

run "private_release_has_bounded_runtime_and_isolated_secrets" {
  command = apply
  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.public) == 0 && google_cloud_scheduler_job.maintenance[0].paused
    error_message = "A prepared release stays private and does not run its schedule."
  }
  assert {
    condition = alltrue([for name, service in google_cloud_run_v2_service.runtime :
      service.template[0].scaling[0].min_instance_count == 0 && service.template[0].containers[0].resources[0].cpu_idle &&
      !service.template[0].session_affinity && !service.invoker_iam_disabled &&
      service.template[0].containers[0].image == "us-central1-docker.pkg.dev/lexcerta-fixture-staging/lexcerta/runtime@${var.release.image_digest}"
    ])
    error_message = "All services must sleep without session affinity, retain IAM checks and use the same digest."
  }
  assert {
    condition = (
      google_cloud_run_v2_service.runtime["public"].template[0].max_instance_request_concurrency == 8 &&
      google_cloud_run_v2_service.runtime["public"].template[0].scaling[0].max_instance_count == 3 &&
      google_cloud_run_v2_service.runtime["public"].scaling[0].max_instance_count == 3 &&
      google_cloud_run_v2_service.runtime["public"].template[0].timeout == "60s" &&
      google_cloud_run_v2_service.runtime["public"].template[0].containers[0].resources[0].limits["memory"] == "1Gi" &&
      google_cloud_run_v2_service.runtime["operator"].template[0].max_instance_request_concurrency == 2 &&
      google_cloud_run_v2_service.runtime["operator"].template[0].scaling[0].max_instance_count == 1
    )
    error_message = "The selected public and operator runtime envelopes must be explicit."
  }
  assert {
    condition     = toset([for env in google_cloud_run_v2_service.runtime["operator"].template[0].containers[0].env : env.name if length(env.value_source) > 0]) == toset(["LEXCERTA_DATABASE_PASSWORD", "API_KEY_PEPPER"])
    error_message = "The operator must not receive the upstream token or another role's password."
  }
  assert {
    condition = alltrue([for purpose, job in google_cloud_run_v2_job.runtime :
      job.template[0].task_count == 1 && job.template[0].parallelism == 1 &&
      toset([for env in job.template[0].template[0].containers[0].env : env.name if length(env.value_source) > 0]) == toset(["LEXCERTA_DATABASE_PASSWORD"])
    ]) && google_cloud_run_v2_job.runtime["migrator"].template[0].template[0].max_retries == 0
    error_message = "Single-task jobs must receive only their database password; migrations cannot automatically retry."
  }
  assert {
    condition = (
      google_cloud_scheduler_job.maintenance[0].http_target[0].uri == "https://run.googleapis.com/v2/projects/lexcerta-fixture-staging/locations/us-central1/jobs/lexcerta-maintenance:run" &&
      length(google_cloud_scheduler_job.maintenance[0].http_target[0].oauth_token) == 1 &&
      length(google_cloud_scheduler_job.maintenance[0].http_target[0].oidc_token) == 0
    )
    error_message = "Scheduler must invoke the Google Jobs API with OAuth and no execution override body."
  }
  assert {
    condition     = google_storage_bucket.sources.soft_delete_policy[0].retention_duration_seconds == 0 && !google_storage_bucket.sources.versioning[0].enabled && google_storage_bucket.sources.public_access_prevention == "enforced"
    error_message = "Source storage must be private and must not retain deleted body versions."
  }
  assert {
    condition     = toset(google_project_iam_custom_role.source_objects["job"].permissions) == toset(["storage.objects.get", "storage.objects.delete"]) && toset(keys(google_storage_bucket_iam_member.source_objects)) == toset(["public", "job"])
    error_message = "Only public and maintenance identities access bodies; maintenance cannot publish them."
  }
  assert {
    condition = (
      google_storage_bucket.recovery.name != google_storage_bucket.sources.name &&
      google_storage_bucket.recovery.uniform_bucket_level_access &&
      google_storage_bucket.recovery.public_access_prevention == "enforced" &&
      !google_storage_bucket.recovery.force_destroy &&
      length(google_storage_bucket.recovery.lifecycle_rule) == 0 &&
      toset(google_project_iam_custom_role.recovery_append.permissions) == toset(["storage.objects.create", "storage.objects.get"]) &&
      google_storage_bucket_iam_member.recovery_append.member == "serviceAccount:lexcerta-operator@lexcerta-fixture-staging.iam.gserviceaccount.com" &&
      endswith(google_storage_bucket_iam_member.recovery_append.condition[0].expression, "/objects/restrictions/v1/staging/')")
    )
    error_message = "Recovery records must survive source expiry and SQL restoration; only the operator may append/read its environment, without delete or overwrite permissions."
  }
  assert {
    condition     = google_logging_project_bucket_config.events.retention_days == 7 && output.operator_url == "https://lexcerta-operator-123456789012.us-central1.run.app"
    error_message = "Retain only seven days of application events and use the deterministic verified operator audience."
  }
  assert {
    condition     = google_cloud_run_v2_service_iam_member.public_canary[0].member == "serviceAccount:lexcerta-operator-invoker@lexcerta-fixture-staging.iam.gserviceaccount.com" && toset(google_project_iam_custom_role.release_update.permissions) == toset(["run.services.update", "run.jobs.update", "run.jobs.run"])
    error_message = "Private canaries need the invoker identity; release updates must not grant IAM changes, deletions or execution overrides."
  }
}

run "activation_enables_public_iam_and_schedule" {
  command = plan
  variables { activate = true }
  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.public) == 1 && google_cloud_run_v2_service_iam_member.public[0].member == "allUsers" && !google_cloud_scheduler_job.maintenance[0].paused
    error_message = "Explicit activation enables only the public service and the maintenance schedule."
  }
  assert {
    condition     = google_monitoring_alert_policy.maintenance_missing.enabled && google_monitoring_alert_policy.maintenance_failed.enabled
    error_message = "Activated environments need missing-run and failure monitoring."
  }
}

run "production_uses_its_own_project_and_github_environment" {
  command   = apply
  state_key = "production"
  override_data {
    target = data.google_project.current
    values = { number = "210987654321" }
  }
  override_resource {
    target = google_service_account.identity["public"]
    values = {
      email     = "lexcerta-public@lexcerta-fixture-production.iam.gserviceaccount.com"
      name      = "projects/lexcerta-fixture-production/serviceAccounts/lexcerta-public@lexcerta-fixture-production.iam.gserviceaccount.com"
      unique_id = "200000000000000000000"
    }
  }
  override_resource {
    target = google_service_account.identity["operator"]
    values = {
      email     = "lexcerta-operator@lexcerta-fixture-production.iam.gserviceaccount.com"
      name      = "projects/lexcerta-fixture-production/serviceAccounts/lexcerta-operator@lexcerta-fixture-production.iam.gserviceaccount.com"
      unique_id = "200000000000000000001"
    }
  }
  override_resource {
    target = google_service_account.identity["job"]
    values = {
      email     = "lexcerta-job@lexcerta-fixture-production.iam.gserviceaccount.com"
      name      = "projects/lexcerta-fixture-production/serviceAccounts/lexcerta-job@lexcerta-fixture-production.iam.gserviceaccount.com"
      unique_id = "200000000000000000002"
    }
  }
  override_resource {
    target = google_service_account.identity["migrator"]
    values = {
      email     = "lexcerta-migrator@lexcerta-fixture-production.iam.gserviceaccount.com"
      name      = "projects/lexcerta-fixture-production/serviceAccounts/lexcerta-migrator@lexcerta-fixture-production.iam.gserviceaccount.com"
      unique_id = "200000000000000000003"
    }
  }
  override_resource {
    target = google_service_account.identity["scheduler"]
    values = {
      email     = "lexcerta-scheduler@lexcerta-fixture-production.iam.gserviceaccount.com"
      name      = "projects/lexcerta-fixture-production/serviceAccounts/lexcerta-scheduler@lexcerta-fixture-production.iam.gserviceaccount.com"
      unique_id = "200000000000000000004"
    }
  }
  override_resource {
    target = google_service_account.identity["operator-invoker"]
    values = {
      email     = "lexcerta-operator-invoker@lexcerta-fixture-production.iam.gserviceaccount.com"
      name      = "projects/lexcerta-fixture-production/serviceAccounts/lexcerta-operator-invoker@lexcerta-fixture-production.iam.gserviceaccount.com"
      unique_id = "200000000000000000005"
    }
  }
  override_resource {
    target = google_service_account.identity["release"]
    values = {
      email     = "lexcerta-release@lexcerta-fixture-production.iam.gserviceaccount.com"
      name      = "projects/lexcerta-fixture-production/serviceAccounts/lexcerta-release@lexcerta-fixture-production.iam.gserviceaccount.com"
      unique_id = "200000000000000000006"
    }
  }
  variables {
    project_id            = "lexcerta-fixture-production"
    environment           = "production"
    notification_channels = ["projects/lexcerta-fixture-production/notificationChannels/5678"]
  }
  assert {
    condition     = google_storage_bucket.sources.name == "lexcerta-fixture-production-lexcerta-sources" && google_cloud_run_v2_service.runtime["public"].template[0].containers[0].image == "us-central1-docker.pkg.dev/lexcerta-fixture-production/lexcerta/runtime@${var.release.image_digest}"
    error_message = "Production must reference its own project resources and the unchanged release digest."
  }
  assert {
    condition     = alltrue([for purpose, service in google_cloud_run_v2_service.runtime : service.template[0].service_account == "lexcerta-${purpose}@lexcerta-fixture-production.iam.gserviceaccount.com"]) && output.operator_url == "https://lexcerta-operator-210987654321.us-central1.run.app"
    error_message = "Production service identities and operator audience must resolve within its own project."
  }
  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "environment:production") && !strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "environment:staging")
    error_message = "Production trust must require the production GitHub environment."
  }
}

run "reject_mutable_secret_version" {
  command = plan
  variables { release = merge(var.release, { secret_versions = merge(var.release.secret_versions, { database_public = "latest" }) }) }
  expect_failures = [var.release]
}

run "reject_pooler_endpoint" {
  command = plan
  variables { release = merge(var.release, { neon_host = "ep-fixture-alpha-pooler.us-east-2.aws.neon.tech" }) }
  expect_failures = [var.release]
}

run "reject_zero_build" {
  command = plan
  variables { release = merge(var.release, { build_id = "0000000000000000000000000000000000000000" }) }
  expect_failures = [var.release]
}

run "reject_four_pilot_customers" {
  command = plan
  variables { release = merge(var.release, { pilot_customers = ["one", "two", "three", "four"] }) }
  expect_failures = [var.release]
}

run "reject_activation_without_alert_delivery" {
  command = plan
  variables {
    activate              = true
    notification_channels = []
  }
  expect_failures = [var.activate]
}

run "reject_cross_project_notification_channel" {
  command = plan
  variables { notification_channels = ["projects/lexcerta-fixture-production/notificationChannels/1234"] }
  expect_failures = [var.notification_channels]
}
