output "container_url" {
  value = var.container_image == "" ? null : scaleway_container.this[0].public_endpoint
}

output "registry_endpoint" {
  value = scaleway_registry_namespace.this.endpoint
}

output "database_endpoint" {
  value     = scaleway_sdb_sql_database.this.endpoint
  sensitive = true
}

output "container_namespace_id" {
  value = scaleway_container_namespace.this.id
}
