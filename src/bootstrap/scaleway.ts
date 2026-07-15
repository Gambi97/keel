import {
  CreateBucketCommand,
  GetBucketPolicyCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import type { Answers } from '../config.js';

/** Which input a validation failure points at, so prompts can re-ask just that. */
export type ScalewayErrorCode = 'auth' | 'project' | 'organization' | 'api';

export class ScalewayError extends Error {
  constructor(
    message: string,
    readonly code: ScalewayErrorCode = 'api',
  ) {
    super(message);
  }
}

const API_BASE = 'https://api.scaleway.com';

/**
 * The generated stack creates non-expiring service credentials (the app's
 * database and Object Storage API keys are read by the container at runtime).
 * An organization security setting that forces API-key expiration makes the
 * very first CI apply fail — hours after the bootstrap looked green. Read the
 * setting here (read-only) so the run can warn upfront, while it is still a
 * 30-second console fix. Returns undefined when the key cannot read it.
 */
async function apiKeyExpirationPolicyWarning(
  secretKey: string,
  organizationId: string,
): Promise<string | undefined> {
  try {
    const response = await fetch(
      `${API_BASE}/iam/v1alpha1/organizations/${organizationId}/security-settings`,
      { headers: { 'X-Auth-Token': secretKey } },
    );
    if (!response.ok) return undefined;
    const settings = (await response.json()) as { max_api_key_expiration_duration?: string };
    const seconds = Number.parseInt(settings.max_api_key_expiration_duration ?? '0', 10);
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined; // "0s" = unlimited
    return (
      'Your Scaleway organization requires API keys to expire ' +
      `(max ${Math.round(seconds / 86400)} days). The database/storage credentials the ` +
      'generated stack creates are non-expiring service credentials, so the first CI apply ' +
      'WILL fail on them. Disable the requirement first (Console → Organization → Security → ' +
      'API keys), then merge or re-run the apply.'
    );
  } catch {
    return undefined;
  }
}

/**
 * Validate credentials with a harmless read call before creating anything.
 * Also confirms the project belongs to the given organization. Read-only: it
 * proves the key can see the project, not that it can create resources. The
 * returned warning flags an org policy that would break the first CI apply.
 */
export async function validateScalewayCredentials(
  scaleway: Pick<Answers['scaleway'], 'secretKey' | 'projectId' | 'organizationId'>,
): Promise<{ warning?: string }> {
  const { secretKey, projectId, organizationId } = scaleway;
  const response = await fetch(`${API_BASE}/account/v3/projects/${projectId}`, {
    headers: { 'X-Auth-Token': secretKey },
  });
  if (response.status === 401 || response.status === 403) {
    throw new ScalewayError(
      'Scaleway rejected the API key (401/403). Check SCW_ACCESS_KEY / SCW_SECRET_KEY and ' +
        'make sure the key can read the project and manage Object Storage, Containers and Serverless SQL.',
      'auth',
    );
  }
  if (response.status === 404) {
    throw new ScalewayError(
      `Scaleway project ${projectId} not found with this API key.`,
      'project',
    );
  }
  if (!response.ok) {
    throw new ScalewayError(
      `Scaleway API error while validating credentials: HTTP ${response.status}.`,
      'api',
    );
  }
  const project = (await response.json()) as { organization_id?: string };
  if (project.organization_id && project.organization_id !== organizationId) {
    throw new ScalewayError(
      `Scaleway project ${projectId} belongs to organization ${project.organization_id}, ` +
        `not ${organizationId}. Check --scw-organization-id.`,
      'organization',
    );
  }
  const warning = await apiKeyExpirationPolicyWarning(secretKey, organizationId);
  return warning ? { warning } : {};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bucket-metadata calls made right after CreateBucket can race its propagation
 * and answer NoSuchBucket for a bucket that provably exists (we created or
 * Head-checked it moments before). Retry exactly that error with a short
 * backoff; anything else is a real failure and is thrown immediately.
 */
export async function retryWhileBucketPropagates<T>(
  fn: () => Promise<T>,
  attempts = 5,
  baseDelayMs = 1000,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if ((error as { name?: string }).name !== 'NoSuchBucket' || attempt >= attempts) {
        throw error;
      }
      await sleep(attempt * baseDelayMs);
    }
  }
}

function s3Client(answers: Answers): S3Client {
  return new S3Client({
    region: answers.region,
    endpoint: `https://s3.${answers.region}.scw.cloud`,
    credentials: {
      accessKeyId: answers.scaleway.accessKey,
      secretAccessKey: answers.scaleway.secretKey,
    },
  });
}

/**
 * Resolve the IAM identity (user or application) that owns the API key, in
 * the `<kind>:<uuid>` principal form bucket policies expect. Returns
 * undefined when the key cannot read IAM; the caller degrades to a warning.
 */
async function apiKeyPrincipal(
  scaleway: Pick<Answers['scaleway'], 'accessKey' | 'secretKey'>,
): Promise<string | undefined> {
  try {
    const response = await fetch(`${API_BASE}/iam/v1alpha1/api-keys/${scaleway.accessKey}`, {
      headers: { 'X-Auth-Token': scaleway.secretKey },
    });
    if (!response.ok) return undefined;
    const key = (await response.json()) as {
      user_id?: string | null;
      application_id?: string | null;
    };
    if (key.application_id) return `application_id:${key.application_id}`;
    if (key.user_id) return `user_id:${key.user_id}`;
    return undefined;
  } catch {
    return undefined;
  }
}

export interface StateBucketResult {
  created: boolean;
  /** Set when the bucket could not be restricted to the bootstrap identity. */
  policyWarning?: string;
}

/**
 * Restrict the state bucket to the identity that owns the bootstrap API key —
 * the same identity CI authenticates with, so the pipeline keeps working.
 * Terraform state contains the generated credentials (DATABASE_URL, S3 keys),
 * and the per-app IAM policies are project-wide for Object Storage: without
 * this policy the app's own storage credential could read the state. An
 * existing policy is never overwritten. Failures degrade to a warning: a
 * missed lockdown must not strand a half-finished bootstrap.
 */
async function lockDownStateBucket(
  client: S3Client,
  bucket: string,
  answers: Answers,
): Promise<string | undefined> {
  try {
    await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    return undefined; // A policy is already in place: leave it alone.
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status !== 404) {
      return (
        `Could not read the policy of bucket "${bucket}" (HTTP ${status ?? 'error'}); ` +
        'the state bucket was NOT restricted to your identity.'
      );
    }
  }
  const principal = await apiKeyPrincipal(answers.scaleway);
  if (!principal) {
    return (
      'Could not resolve the IAM identity behind the API key, so the state bucket was NOT ' +
      'restricted: any Object Storage credential in the project can read the Terraform state. ' +
      'Grant the key IAM read access and re-run, or add a bucket policy manually.'
    );
  }
  const policy = {
    Version: '2023-04-17',
    Id: 'keel-state-bucket-bootstrap-identity-only',
    Statement: [
      {
        Sid: 'OnlyBootstrapIdentity',
        Effect: 'Allow',
        Principal: { SCW: principal },
        Action: ['*'],
        Resource: [bucket, `${bucket}/*`],
      },
    ],
  };
  try {
    await retryWhileBucketPropagates(() =>
      client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) })),
    );
    return undefined;
  } catch (error) {
    return (
      `Could not apply a policy to bucket "${bucket}" ` +
      `(${error instanceof Error ? error.message : String(error)}); ` +
      'the state bucket was NOT restricted to your identity. ' +
      'Re-run keel to retry this step.'
    );
  }
}

/**
 * Create the Terraform state bucket if it does not exist yet (idempotent) and
 * restrict it to the bootstrap identity via a bucket policy.
 */
export async function ensureStateBucket(answers: Answers): Promise<StateBucketResult> {
  const client = s3Client(answers);
  const bucket = answers.stateBucket;
  let created = false;
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    // Already exists and we own it (resume): still ensure the policy below.
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 403) {
      throw new ScalewayError(
        `Bucket "${bucket}" already exists but is owned by another account. ` +
          'Choose a different project name.',
      );
    }
    if (status !== 404 && status !== 301) {
      throw error;
    }
    // HeadBucket said "missing", but on Scaleway it can 404/301 a bucket we
    // actually own (region/endpoint quirks, eventual consistency). CreateBucket
    // is the authoritative check: treat AlreadyOwnedByYou as a resume, and
    // AlreadyExists (owned by someone else) as the name clash Head would report.
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      // Versioning protects the state history against accidental overwrites.
      await retryWhileBucketPropagates(() =>
        client.send(
          new PutBucketVersioningCommand({
            Bucket: bucket,
            VersioningConfiguration: { Status: 'Enabled' },
          }),
        ),
      );
      created = true;
    } catch (createError) {
      const name = (createError as { name?: string }).name;
      if (name === 'BucketAlreadyExists') {
        throw new ScalewayError(
          `Bucket "${bucket}" already exists but is owned by another account. ` +
            'Choose a different project name.',
        );
      }
      if (name !== 'BucketAlreadyOwnedByYou') {
        throw createError;
      }
      // Already ours from an earlier run: fall through to (re)apply the policy.
    }
  }
  const policyWarning = await lockDownStateBucket(client, bucket, answers);
  return policyWarning ? { created, policyWarning } : { created };
}
