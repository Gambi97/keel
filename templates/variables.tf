variable "project_name" {
  description = "Project name, used as prefix for every resource."
  type        = string
}

variable "region" {
  description = "Scaleway region."
  type        = string
}

variable "environment" {
  description = "Deployment environment. Must match the Terraform workspace and the Infisical environment slug."
  type        = string

  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be either \"staging\" or \"prod\"."
  }
}

variable "container_image" {
  description = "Full registry image to deploy (e.g. rg.fr-par.scw.cloud/ns/app:tag). Leave empty to provision everything except the container."
  type        = string
  default     = ""
}

variable "container_port" {
  description = "Port the application listens on."
  type        = number
  default     = 8080
}

variable "cpu_limit" {
  description = "Container CPU limit in mvCPU."
  type        = number
  default     = 500
}

variable "memory_limit" {
  description = "Container memory limit in MB."
  type        = number
  default     = 1024
}

variable "min_scale" {
  description = "Minimum number of container instances."
  type        = number
  default     = 0
}

variable "max_scale" {
  description = "Maximum number of container instances."
  type        = number
  default     = 2
}

variable "db_min_cpu" {
  description = "Serverless SQL Database minimum CPU."
  type        = number
  default     = 0
}

variable "db_max_cpu" {
  description = "Serverless SQL Database maximum CPU."
  type        = number
  default     = 4
}

variable "enable_basic_auth" {
  description = "When true, the container gets BASIC_AUTH_ENABLED=true and the app is expected to enforce Basic Auth using credentials stored in Infisical."
  type        = bool
  default     = false
}

variable "infisical_host" {
  description = "Infisical instance URL."
  type        = string
  default     = "https://app.infisical.com"
}

variable "infisical_project_id" {
  description = "Infisical project (workspace) ID holding the application secrets."
  type        = string
}

variable "infisical_client_id" {
  description = "Infisical machine identity client ID (Universal Auth)."
  type        = string
  sensitive   = true
}

variable "infisical_client_secret" {
  description = "Infisical machine identity client secret (Universal Auth)."
  type        = string
  sensitive   = true
}
