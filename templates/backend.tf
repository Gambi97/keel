# Remote state on Scaleway Object Storage (S3-compatible).
# Bucket, region and endpoint are provided at init time:
#   terraform init -backend-config=backend.hcl
# Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
# (set them to your Scaleway access key / secret key).
# Each workspace stores its state under env:/<workspace>/.
# use_lockfile enables S3-native state locking (Terraform >= 1.10); Scaleway
# Object Storage supports the conditional writes it relies on.
terraform {
  backend "s3" {
    key                         = "terraform.tfstate"
    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }
}
