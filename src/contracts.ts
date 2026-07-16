/**
 * Names shared between the bootstrap code and the generated repository.
 *
 * The CLI configures the user's account by name (required status checks,
 * Actions secrets/variables, seeded Infisical secrets) and the generated
 * workflows and Terraform reference the same names. A rename on one side
 * without the other passes CI here and breaks at runtime in the user's
 * account — so both sides import these constants, and contracts.test.ts
 * renders the templates and asserts they still agree.
 */

/**
 * Job name of the plan workflow for one environment; branch protection
 * requires exactly these contexts before a PR can merge.
 */
export function planStatusCheckContext(environment: string): string {
  return `plan (${environment})`;
}

/**
 * Version of the docking contract between keel and the generated repository
 * (output naming, manifest schema, tfvars conventions). Recorded in the
 * committed .keel/manifest.json; future tooling that extends a generated
 * repo checks it before touching anything.
 */
export const CONTRACT_VERSION = 1;

/** Base Terraform output consumed by .github/scripts/sync-secrets.sh. */
export const INFISICAL_SECRETS_OUTPUT = 'infisical_secrets';

/**
 * Regex (verbatim in sync-secrets.sh) matching the base output plus any
 * module-contributed "infisical_secrets_<name>" output. A module added to a
 * generated repo exposes its own map under that name and the pipeline syncs
 * it — no edit to outputs.tf needed (file-additive extension).
 */
export const INFISICAL_SECRETS_OUTPUT_PATTERN = '^infisical_secrets(_[a-z0-9_]+)?$';

/**
 * Keys always present in the synced map: seeded as placeholders by the CLI,
 * produced by the root outputs, overwritten by the pipeline after each apply.
 */
export const BASE_SYNCED_KEYS = ['DATABASE_URL', 'APP_URL'] as const;

/**
 * Basic Auth crosses the boundary in three places: the CLI seeds these two
 * secrets in Infisical (non-production), the generated app_stack injects the
 * flag below, and the user's app enforces it. [user, password] in this order.
 */
export const BASIC_AUTH_SECRET_KEYS = ['BASIC_AUTH_USER', 'BASIC_AUTH_PASSWORD'] as const;
export const BASIC_AUTH_FLAG = 'BASIC_AUTH_ENABLED';

/**
 * keel's placeholder page: the very first apply brings a keel-branded page
 * up, so APP_URL is real from day zero. Built and pushed to GHCR by the
 * Placeholder image workflow from placeholder/ in this repo; it is also the
 * reference implementation of the env contract (PROJECT_NAME,
 * APP_ENVIRONMENT, BASIC_AUTH_*). Users replace it by editing
 * container_image — or set "" to skip the container entirely.
 *
 * The container never runs from GHCR: the generated tfvars point at the
 * environment's own Scaleway registry (placeholderImageRef), and the apply
 * workflow's seed step copies the GHCR source there once, on the first
 * apply. GHCR is a one-time source, not a runtime dependency. Bump the tag
 * whenever placeholder/ changes what the image serves.
 */
export const PLACEHOLDER_IMAGE_NAME = 'keel-placeholder';
export const PLACEHOLDER_IMAGE_TAG = 'v2';
export const PLACEHOLDER_SOURCE_IMAGE = `ghcr.io/gambi97/${PLACEHOLDER_IMAGE_NAME}:${PLACEHOLDER_IMAGE_TAG}`;

/**
 * The placeholder as the environment's own registry sees it: rendered as the
 * default container_image in <env>.tfvars, compared verbatim by the apply
 * workflow's seed step to decide whether seeding is still needed.
 */
export function placeholderImageRef(projectName: string, region: string, envSlug: string): string {
  return `rg.${region}.scw.cloud/${resourceName(projectName, envSlug)}/${PLACEHOLDER_IMAGE_NAME}:${PLACEHOLDER_IMAGE_TAG}`;
}

/**
 * Plain environment variables the generated app_stack injects into the
 * container, so any image (the placeholder first) knows what it runs as.
 */
export const CONTAINER_ENV_KEYS = ['PROJECT_NAME', 'APP_ENVIRONMENT'] as const;

/**
 * Naming convention for per-environment resources (registry, namespaces,
 * database, buckets…): mirrored by `local.name` in the app_stack template,
 * which contracts.test.ts pins against this function.
 */
export function resourceName(projectName: string, envSlug: string): string {
  return `${projectName}-${envSlug}`;
}

/**
 * Name suffixes (after resourceName) of the per-environment resources the
 * app_stack template creates. `keel teardown` deletes by these exact names,
 * so a rename in the template without this table leaves orphans behind;
 * contracts.test.ts pins both sides.
 */
export const ENV_RESOURCE_SUFFIXES = {
  dbIamApplication: '-db',
  dbIamPolicy: '-db-access',
  storageIamApplication: '-storage',
  storageIamPolicy: '-storage-access',
  filesBucket: '-files',
} as const;

/**
 * Object Storage coordinates: seeded as placeholders by the CLI, produced by
 * the infisical_secrets output, synced to Infisical by the pipeline.
 */
export const S3_SECRET_KEYS = [
  'S3_BUCKET',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
] as const;

/** Encrypted Actions secrets set by configureRepo, read by the workflows. */
export const CI_SECRET_NAMES = [
  'SCW_ACCESS_KEY',
  'SCW_SECRET_KEY',
  'SCW_DEFAULT_PROJECT_ID',
  'SCW_DEFAULT_ORGANIZATION_ID',
  'INFISICAL_CLIENT_ID',
  'INFISICAL_CLIENT_SECRET',
] as const;
export type CiSecretName = (typeof CI_SECRET_NAMES)[number];

/** Plain Actions variables set by configureRepo, read by the workflows. */
export const CI_VARIABLE_NAMES = [
  'TF_STATE_BUCKET',
  'SCW_REGION',
  'INFISICAL_PROJECT_ID',
  'INFISICAL_HOST',
] as const;
export type CiVariableName = (typeof CI_VARIABLE_NAMES)[number];
