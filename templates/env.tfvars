# Non-sensitive __ENVIRONMENT__ configuration. Safe to commit.
project_name          = "__PROJECT_NAME__"
region                = "__REGION__"
environment           = "__ENVIRONMENT__"
enable_basic_auth     = __ENABLE_BASIC_AUTH__
enable_object_storage = __ENABLE_OBJECT_STORAGE__
min_scale             = __MIN_SCALE__
max_scale             = __MAX_SCALE__

# Per-instance resources (mvCPU / MB). Idle instances scale to zero, so these
# shape cost and cold-start speed only while serving traffic.
cpu_limit    = __CPU_LIMIT__
memory_limit = __MEMORY_LIMIT__

# The image this environment runs. Starts as keel's placeholder page so the
# first apply brings a container up and APP_URL is real; replace it with your
# application's image when ready ("" skips the container entirely).
container_image = "__CONTAINER_IMAGE__"
