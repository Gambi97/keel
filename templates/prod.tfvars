# Non-sensitive production configuration. Safe to commit.
project_name      = "__PROJECT_NAME__"
region            = "__REGION__"
environment       = "prod"
enable_basic_auth = false
min_scale         = __PROD_MIN_SCALE__
max_scale         = __PROD_MAX_SCALE__
