# Non-sensitive staging configuration. Safe to commit.
project_name      = "__PROJECT_NAME__"
region            = "__REGION__"
environment       = "staging"
enable_basic_auth = true
min_scale         = __STAGING_MIN_SCALE__
max_scale         = __STAGING_MAX_SCALE__
