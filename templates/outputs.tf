output "container_url" {
  description = "Auto-generated Scaleway URL of the deployed container (null until an image is deployed)."
  value       = module.app_stack.container_url
}

output "registry_endpoint" {
  description = "Container Registry endpoint to push application images to."
  value       = module.app_stack.registry_endpoint
}

output "database_endpoint" {
  description = "Serverless SQL Database connection endpoint."
  value       = module.app_stack.database_endpoint
  sensitive   = true
}

output "container_namespace_id" {
  description = "Scaleway Containers namespace ID."
  value       = module.app_stack.container_namespace_id
}
