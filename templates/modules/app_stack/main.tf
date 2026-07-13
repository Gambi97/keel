locals {
  name = "${var.project_name}-${var.environment}"
}

resource "scaleway_registry_namespace" "this" {
  name      = local.name
  region    = var.region
  is_public = false
}

resource "scaleway_container_namespace" "this" {
  name   = local.name
  region = var.region
}

resource "scaleway_sdb_sql_database" "this" {
  name    = local.name
  region  = var.region
  min_cpu = var.db_min_cpu
  max_cpu = var.db_max_cpu
}

# The container is gated on an image being available: registry and database
# are provisioned first, the container appears once an image has been pushed
# and container_image is set.
resource "scaleway_container" "this" {
  count = var.container_image == "" ? 0 : 1

  name               = var.project_name
  namespace_id       = scaleway_container_namespace.this.id
  image              = var.container_image
  port               = var.container_port
  cpu_limit          = var.cpu_limit
  memory_limit_bytes = var.memory_limit * 1024 * 1024
  min_scale          = var.min_scale
  max_scale          = var.max_scale
  privacy            = "public"

  environment_variables = var.enable_basic_auth ? {
    BASIC_AUTH_ENABLED = "true"
  } : {}

  # BASIC_AUTH_USER / BASIC_AUTH_PASSWORD / DATABASE_URL arrive here from
  # Infisical; the app is responsible for enforcing Basic Auth when enabled.
  secret_environment_variables = var.secret_environment_variables
}
