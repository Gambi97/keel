output "container_url" {
  description = "Auto-generated Scaleway URL of the deployed container (null until an image is deployed)."
  value       = module.app_stack.container_url
}

output "registry_endpoint" {
  description = "Container Registry endpoint to push application images to."
  value       = module.app_stack.registry_endpoint
}

output "database_url" {
  description = "Ready-to-use Postgres connection string (dedicated least-privilege IAM credential)."
  value       = module.app_stack.database_url
  sensitive   = true
}

output "container_namespace_id" {
  description = "Scaleway Containers namespace ID."
  value       = module.app_stack.container_namespace_id
}

output "object_bucket_name" {
  description = "Object Storage bucket for application files (null unless enabled)."
  value       = module.app_stack.object_bucket_name
}

# The secrets the pipeline pushes to Infisical after each apply: always
# DATABASE_URL and APP_URL, plus the S3_* coordinates when Object Storage is
# enabled. A module added to this repo can contribute its own secrets by
# exposing an output named "infisical_secrets_<name>" (a map of string): the
# pipeline collects every output matching that prefix, so extending never
# requires editing this file.
output "infisical_secrets" {
  description = "Secrets synced to Infisical after each apply."
  sensitive   = true
  value = merge(
    {
      DATABASE_URL = module.app_stack.database_url
      # Public URL of the app; null until a container image is deployed (the
      # pipeline skips null values and syncs it on the first apply after).
      APP_URL = module.app_stack.container_url
    },
    var.enable_object_storage ? {
      S3_BUCKET     = module.app_stack.object_bucket_name
      S3_ENDPOINT   = module.app_stack.object_bucket_endpoint
      S3_REGION     = var.region
      S3_ACCESS_KEY = module.app_stack.object_storage_access_key
      S3_SECRET_KEY = module.app_stack.object_storage_secret_key
    } : {}
  )
}
