# Application secrets live in Infisical, one environment per Terraform workspace.
data "infisical_secrets" "app" {
  env_slug     = var.environment
  workspace_id = var.infisical_project_id
  folder_path  = "/"

  lifecycle {
    # Guards against applying one environment's tfvars into another
    # environment's state (e.g. prod.tfvars while the staging workspace is
    # selected), which would create prod-named resources in staging state.
    precondition {
      condition     = terraform.workspace == var.environment
      error_message = "The selected Terraform workspace must match var.environment: run `terraform workspace select <env>` before plan/apply with <env>.tfvars."
    }
  }
}

module "app_stack" {
  source = "./modules/app_stack"

  project_name    = var.project_name
  environment     = var.environment
  region          = var.region
  container_image = var.container_image
  container_port  = var.container_port
  cpu_limit       = var.cpu_limit
  memory_limit    = var.memory_limit
  min_scale       = var.min_scale
  max_scale       = var.max_scale
  db_min_cpu      = var.db_min_cpu
  db_max_cpu      = var.db_max_cpu

  enable_basic_auth     = var.enable_basic_auth
  enable_object_storage = var.enable_object_storage

  secret_environment_variables = {
    for name, secret in data.infisical_secrets.app.secrets : name => secret.value
  }
}
