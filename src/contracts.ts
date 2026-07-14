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

/** Root Terraform output consumed by .github/scripts/sync-secrets.sh. */
export const INFISICAL_SECRETS_OUTPUT = 'infisical_secrets';

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
