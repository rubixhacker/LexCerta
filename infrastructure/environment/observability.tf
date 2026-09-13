locals {
  workload_logs    = <<-FILTER
    (resource.type="cloud_run_revision" AND resource.labels.service_name=~"^lexcerta-(public|operator)$")
    OR (resource.type="cloud_run_job" AND resource.labels.job_name=~"^lexcerta-(maintenance|migrate)$")
  FILTER
  application_logs = <<-FILTER
    (${local.workload_logs})
    AND (log_id("run.googleapis.com/stdout") OR log_id("run.googleapis.com/stderr"))
    AND jsonPayload.event=~"^(startup_failed|process_failed|maintenance_startup_failed|maintenance_failed|maintenance_finished|migration_startup_failed|migration_failed|migration_finished)$"
  FILTER
  maintenance_logs = "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"lexcerta-maintenance\""
}

# This exclusion only controls this project's _Default sink. Other project and
# ancestor sinks must be inventoried and receive the same workload exclusion
# before activation. _Required audit retention remains Google's 400-day rule.
resource "google_logging_project_exclusion" "workloads" {
  name        = "lexcerta-workloads"
  description = "Route LexCerta workload logs only through the explicit application-event sink."
  filter      = local.workload_logs
  depends_on  = [google_project_service.api]
}

resource "google_logging_project_bucket_config" "events" {
  project        = var.project_id
  location       = local.region
  bucket_id      = "lexcerta-events"
  retention_days = 7
  depends_on     = [google_project_service.api]
}

# A sink into a bucket in the same project is automatically authorized by
# Logging; no application service account gets logging administration rights.
resource "google_logging_project_sink" "events" {
  name        = "lexcerta-events"
  destination = "logging.googleapis.com/${google_logging_project_bucket_config.events.id}"
  filter      = local.application_logs
  disabled    = false
}

resource "google_logging_metric" "maintenance_healthy" {
  name        = "lexcerta_maintenance_healthy"
  description = "Finished maintenance invocations whose durable cleanup and lifecycle slots are both current. No customer or source labels."
  filter      = "${local.maintenance_logs} AND jsonPayload.event=\"maintenance_finished\" AND jsonPayload.health.cleanup.overdue=false AND jsonPayload.health.lifecycle.overdue=false"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
  depends_on = [google_project_service.api]
}

resource "google_monitoring_alert_policy" "maintenance_missing" {
  display_name          = "LexCerta ${var.environment}: no healthy maintenance in two hours"
  combiner              = "OR"
  enabled               = var.release != null && length(var.notification_channels) > 0
  notification_channels = sort(tolist(var.notification_channels))
  user_labels           = local.labels
  conditions {
    display_name = "Missing healthy maintenance, including a never-created time series"
    condition_prometheus_query_language {
      query               = trimspace(templatefile("${path.module}/maintenance-missing.promql.tftpl", { project_id = var.project_id }))
      duration            = "0s"
      evaluation_interval = "60s"
    }
  }
  documentation {
    mime_type = "text/markdown"
    content   = "No healthy maintenance event arrived in two hours. Check Scheduler delivery, Cloud Run execution and the durable cleanup/lifecycle progress. A missing job cannot log its own failure. Run the existing bounded job after resolving the cause; do not reset progress or replay arbitrary SQL. See operations/maintenance-jobs.md."
  }
  depends_on = [google_logging_metric.maintenance_healthy]
}

resource "google_monitoring_alert_policy" "maintenance_failed" {
  display_name          = "LexCerta ${var.environment}: maintenance failed or overdue"
  combiner              = "OR"
  enabled               = var.release != null && length(var.notification_channels) > 0
  notification_channels = sort(tolist(var.notification_channels))
  user_labels           = local.labels
  conditions {
    display_name = "Partial, failed or stale maintenance"
    condition_matched_log {
      filter = <<-FILTER
        ${local.maintenance_logs} AND (
          jsonPayload.event=~"^maintenance_(startup_failed|failed)$"
          OR (jsonPayload.event="maintenance_finished" AND (
            jsonPayload.outcome="partial"
            OR jsonPayload.health.cleanup.overdue=true
            OR jsonPayload.health.lifecycle.overdue=true
          ))
        )
      FILTER
    }
  }
  alert_strategy {
    notification_rate_limit { period = "3600s" }
    auto_close = "86400s"
  }
  documentation {
    mime_type = "text/markdown"
    content   = "Maintenance failed, stopped with partial work, or found overdue durable progress. Cleanup is overdue at two hours and lifecycle at 26 hours of database slot time. Inspect bounded counts and database progress through the maintenance runbook; do not export source text or credentials into incident logs."
  }
}
