terraform {
  # 1.10+ is required for S3-native state locking (use_lockfile).
  required_version = ">= 1.10.0"

  required_providers {
    scaleway = {
      source  = "scaleway/scaleway"
      version = "~> 2.0"
    }
    infisical = {
      source  = "infisical/infisical"
      version = "~> 0.15"
    }
  }
}
