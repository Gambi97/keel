# Non-sensitive __ENVIRONMENT__ configuration. Safe to commit.
project_name          = "__PROJECT_NAME__"
region                = "__REGION__"
environment           = "__ENVIRONMENT__"
enable_basic_auth     = __ENABLE_BASIC_AUTH__
enable_object_storage = __ENABLE_OBJECT_STORAGE__
min_scale             = __MIN_SCALE__
max_scale             = __MAX_SCALE__

# The image this environment runs. Starts as keel's placeholder page so the
# first apply brings a container up and APP_URL is real; replace it with your
# application's image when ready ("" skips the container entirely).
container_image = "__CONTAINER_IMAGE__"
