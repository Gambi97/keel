# Application secrets live in Infisical, one environment per Terraform workspace.
data "infisical_secrets" "app" {
  env_slug     = var.environment
  workspace_id = var.infisical_project_id
  folder_path  = "/"
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
