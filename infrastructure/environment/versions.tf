terraform {
  required_version = "= 1.16.2"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "= 8.2.0"
    }
  }
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = "us-central1"
}

data "google_project" "current" {
  project_id = var.project_id
}
