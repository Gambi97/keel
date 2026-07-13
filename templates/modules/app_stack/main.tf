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

# Dedicated least-privilege credential for the application: it can reach the
# database and nothing else. Serverless SQL authenticates with IAM: username
# is the application ID, password its API secret key.
resource "scaleway_iam_application" "db" {
  name        = "${local.name}-db"
  description = "Database access for ${local.name} (managed by Terraform)"
}

resource "scaleway_iam_policy" "db_access" {
  name           = "${local.name}-db-access"
  description    = "Read/write access to the ${local.name} Serverless SQL database"
  application_id = scaleway_iam_application.db.id

  rule {
    project_ids          = [scaleway_sdb_sql_database.this.project_id]
    permission_set_names = ["ServerlessSQLDatabaseReadWrite"]
  }
}

resource "scaleway_iam_api_key" "db" {
  application_id = scaleway_iam_application.db.id
  description    = "Database credential for ${local.name} (managed by Terraform)"
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
