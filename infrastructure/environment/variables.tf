variable "project_id" {
  description = "Existing, dedicated GCP project for this environment. Staging and production require distinct projects and remote state."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Supply an existing GCP project ID."
  }
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "The environment must be staging or production."
  }
}

variable "operator_members" {
  description = "Verified human IAM members allowed to impersonate this environment's operator invoker. No service runtime identity belongs here."
  type        = set(string)
  validation {
    condition     = length(var.operator_members) >= 1 && length(var.operator_members) <= 10 && alltrue([for member in var.operator_members : can(regex("^user:[^@ ]+@[^@ ]+\\.[^@ ]+$", member))])
    error_message = "Supply one to ten verified user:email IAM members."
  }
}

variable "release" {
  description = "Non-secret release inputs. Null creates only foundation resources. Populate secret versions separately; never supply secret values to Terraform."
  type = object({
    image_digest                = string
    build_id                    = string
    neon_host                   = string
    courtlistener_credential_id = string
    pilot_customers             = set(string)
    secret_versions = object({
      database_public   = string
      database_operator = string
      database_job      = string
      database_migrator = string
      api_key_pepper    = string
      courtlistener     = string
    })
  })
  default = null
  validation {
    condition = var.release == null ? true : (
      can(regex("^sha256:[a-f0-9]{64}$", var.release.image_digest)) &&
      can(regex("^[a-f0-9]{40}$", var.release.build_id)) && var.release.build_id != "0000000000000000000000000000000000000000" &&
      can(regex("^ep-[a-z0-9]+(-[a-z0-9]+)*\\.(c-[0-9]+\\.)?us-east-2\\.aws\\.neon\\.tech$", var.release.neon_host)) &&
      !endswith(split(".", var.release.neon_host)[0], "-pooler") &&
      can(regex("^[A-Za-z0-9_-]{1,128}$", var.release.courtlistener_credential_id)) &&
      length(var.release.pilot_customers) >= 1 && length(var.release.pilot_customers) <= 3 &&
      alltrue([for customer in var.release.pilot_customers : can(regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$", customer))]) &&
      alltrue([for version in values(var.release.secret_versions) : can(regex("^[1-9][0-9]*$", version))])
    )
    error_message = "Release requires a digest, real build SHA, direct Ohio Neon host, one to three customers and numeric secret versions."
  }
}

variable "activate" {
  description = "Enable public IAM invocation and the maintenance schedule only after migrations and the environment's release gates pass."
  type        = bool
  default     = false
  validation {
    condition     = !var.activate || var.release != null
    error_message = "Activation requires a configured release."
  }
  validation {
    condition     = !var.activate || length(var.notification_channels) > 0
    error_message = "Activation requires an existing, verified notification channel."
  }
}

variable "notification_channels" {
  description = "Existing, verified Cloud Monitoring channel resource names in this project. Delivery must be exercised before activation."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for channel in var.notification_channels : startswith(channel, "projects/${var.project_id}/notificationChannels/") && can(regex("/notificationChannels/[0-9]+$", channel))])
    error_message = "Notification channels must belong to this environment's project."
  }
}

locals {
  region        = "us-central1"
  labels        = { application = "lexcerta", environment = var.environment }
  runtime_roles = toset(["public", "operator", "job", "migrator"])
  secret_readers = {
    database_public   = ["public"]
    database_operator = ["operator"]
    database_job      = ["job"]
    database_migrator = ["migrator"]
    api_key_pepper    = ["public", "operator"]
    courtlistener     = ["public"]
  }
  secret_grants = merge([for secret, readers in local.secret_readers : {
    for reader in readers : "${secret}/${reader}" => { secret = secret, reader = reader }
  }]...)
  operator_url = "https://lexcerta-operator-${data.google_project.current.number}.${local.region}.run.app"
  public_url   = "https://lexcerta-public-${data.google_project.current.number}.${local.region}.run.app"
  image        = var.release == null ? null : "${local.region}-docker.pkg.dev/${var.project_id}/lexcerta/runtime@${var.release.image_digest}"
}
