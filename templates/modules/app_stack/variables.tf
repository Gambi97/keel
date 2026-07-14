variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "container_image" {
  type    = string
  default = ""
}

variable "container_port" {
  type = number
}

variable "cpu_limit" {
  type = number
}

variable "memory_limit" {
  type = number
}

variable "min_scale" {
  type = number
}

variable "max_scale" {
  type = number
}

variable "db_min_cpu" {
  type = number
}

variable "db_max_cpu" {
  type = number
}

variable "enable_basic_auth" {
  type = bool
}

variable "enable_object_storage" {
  type    = bool
  default = false
}

variable "secret_environment_variables" {
  description = "Secrets injected into the container, sourced from Infisical."
  type        = map(string)
  sensitive   = true
  default     = {}
}
