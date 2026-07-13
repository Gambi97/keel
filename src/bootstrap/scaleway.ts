import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import type { Answers } from '../config.js';

export class ScalewayError extends Error {}

const API_BASE = 'https://api.scaleway.com';

/**
 * Validate credentials with a harmless read call before creating anything.
 * Also confirms the project belongs to the given organization.
 */
export async function validateScalewayCredentials(answers: Answers): Promise<void> {
  const { secretKey, projectId, organizationId } = answers.scaleway;
  const response = await fetch(`${API_BASE}/account/v3/projects/${projectId}`, {
    headers: { 'X-Auth-Token': secretKey },
  });
  if (response.status === 401 || response.status === 403) {
    throw new ScalewayError(
      'Scaleway rejected the API key (401/403). Check SCW_ACCESS_KEY / SCW_SECRET_KEY and ' +
        'make sure the key can read the project and manage Object Storage, Containers and Serverless SQL.',
    );
  }
  if (response.status === 404) {
    throw new ScalewayError(`Scaleway project ${projectId} not found with this API key.`);
  }
  if (!response.ok) {
    throw new ScalewayError(
      `Scaleway API error while validating credentials: HTTP ${response.status}.`,
    );
  }
  const project = (await response.json()) as { organization_id?: string };
  if (project.organization_id && project.organization_id !== organizationId) {
    throw new ScalewayError(
      `Scaleway project ${projectId} belongs to organization ${project.organization_id}, ` +
        `not ${organizationId}. Check --scw-organization-id.`,
    );
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

/** Create the Terraform state bucket if it does not exist yet (idempotent). */
export async function ensureStateBucket(answers: Answers): Promise<{ created: boolean }> {
  const client = s3Client(answers);
  const bucket = answers.stateBucket;
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return { created: false }; // Already exists and we own it.
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
  }
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  // Versioning protects the state history against accidental overwrites.
  await client.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: 'Enabled' },
    }),
  );
  return { created: true };
}
