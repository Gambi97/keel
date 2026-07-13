output "container_url" {
  value = var.container_image == "" ? null : scaleway_container.this[0].public_endpoint
}

output "registry_endpoint" {
  value = scaleway_registry_namespace.this.endpoint
}

output "database_url" {
  # Ready-to-use connection string: dedicated IAM application as username,
  # its API secret key as password (see the connect-to-a-database docs).
  value = format(
    "postgres://%s:%s@%s",
    scaleway_iam_application.db.id,
    scaleway_iam_api_key.db.secret_key,
    trimprefix(scaleway_sdb_sql_database.this.endpoint, "postgres://"),
  )
  sensitive = true
}

output "container_namespace_id" {
  value = scaleway_container_namespace.this.id
}
