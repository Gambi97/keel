import { randomBytes } from 'node:crypto';

import type { Answers } from '../config.js';

export class InfisicalError extends Error {}

interface InfisicalEnvironment {
  name: string;
  slug: string;
}

interface InfisicalProject {
  id: string;
  name: string;
  environments?: InfisicalEnvironment[];
}

async function api<T>(
  host: string,
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${host}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let data: T;
  try {
    data = (text ? JSON.parse(text) : {}) as T;
  } catch {
    data = {} as T;
  }
  return { status: response.status, data };
}

export async function login(answers: Answers): Promise<string> {
  const { host, clientId, clientSecret } = answers.infisical;
  const { status, data } = await api<{ accessToken?: string; message?: string }>(
    host,
    '/api/v1/auth/universal-auth/login',
    { method: 'POST', body: { clientId, clientSecret } },
  );
  if (status !== 200 || !data.accessToken) {
    throw new InfisicalError(
      `Infisical Universal Auth login failed (HTTP ${status}${data.message ? `: ${data.message}` : ''}). ` +
        'Check the machine identity client ID/secret and that Universal Auth is enabled.',
    );
  }
  return data.accessToken;
}

async function findProject(
  host: string,
  token: string,
  name: string,
): Promise<InfisicalProject | undefined> {
  const { status, data } = await api<{ workspaces?: InfisicalProject[] }>(
    host,
    '/api/v1/workspace',
    { token },
  );
  if (status !== 200) return undefined;
  return data.workspaces?.find((w) => w.name === name);
}

async function createProject(host: string, token: string, name: string): Promise<InfisicalProject> {
  const { status, data } = await api<{ project?: InfisicalProject; message?: string }>(
    host,
    '/api/v2/workspace',
    { method: 'POST', token, body: { projectName: name } },
  );
  if (status !== 200 || !data.project) {
    throw new InfisicalError(
      `Could not create Infisical project "${name}" (HTTP ${status}${data.message ? `: ${data.message}` : ''}). ` +
        'The machine identity needs permission to create projects.',
    );
  }
  return data.project;
}

async function ensureEnvironment(
  host: string,
  token: string,
  project: InfisicalProject,
  slug: string,
  name: string,
): Promise<void> {
  if (project.environments?.some((e) => e.slug === slug)) return;
  const { status, data } = await api<{ message?: string }>(
    host,
    `/api/v1/workspace/${project.id}/environments`,
    { method: 'POST', token, body: { name, slug } },
  );
  // 400 usually means the environment already exists: fine for idempotency.
  if (status !== 200 && status !== 400) {
    throw new InfisicalError(
      `Could not create Infisical environment "${slug}" (HTTP ${status}${data.message ? `: ${data.message}` : ''}).`,
    );
  }
}

async function seedSecret(
  host: string,
  token: string,
  projectId: string,
  environment: string,
  name: string,
  value: string,
): Promise<void> {
  const { status, data } = await api<{ message?: string }>(host, `/api/v3/secrets/raw/${name}`, {
    method: 'POST',
    token,
    body: {
      workspaceId: projectId,
      environment,
      secretPath: '/',
      secretValue: value,
      type: 'shared',
    },
  });
  if (status === 400 && /exist/i.test(data.message ?? '')) {
    return; // Already seeded on a previous run: never overwrite.
  }
  if (status !== 200) {
    throw new InfisicalError(
      `Could not seed secret ${name} in ${environment} (HTTP ${status}${data.message ? `: ${data.message}` : ''}).`,
    );
  }
}

export interface InfisicalBootstrapResult {
  projectId: string;
  createdProject: boolean;
}

const S3_PLACEHOLDER_KEYS = [
  'S3_BUCKET',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
];

/** Create/reuse the project, ensure every environment, seed placeholder secrets. */
export async function bootstrapInfisical(answers: Answers): Promise<InfisicalBootstrapResult> {
  const { host, projectName } = answers.infisical;
  const token = await login(answers);

  let createdProject = false;
  let project = await findProject(host, token, projectName);
  if (!project) {
    project = await createProject(host, token, projectName);
    createdProject = true;
  }

  for (const env of answers.environments) {
    await ensureEnvironment(host, token, project, env.slug, env.displayName);
  }

  // Real values arrive from the pipeline after the first apply; seed placeholders
  // now so the secret paths exist and the container has something to read.
  const placeholder = 'placeholder-updated-by-pipeline-after-first-apply';
  for (const env of answers.environments) {
    if (env.basicAuth) {
      await seedSecret(host, token, project.id, env.slug, 'BASIC_AUTH_USER', env.slug);
      await seedSecret(
        host,
        token,
        project.id,
        env.slug,
        'BASIC_AUTH_PASSWORD',
        randomBytes(18).toString('base64url'),
      );
    }
    await seedSecret(host, token, project.id, env.slug, 'DATABASE_URL', placeholder);
    if (answers.objectStorage) {
      for (const key of S3_PLACEHOLDER_KEYS) {
        await seedSecret(host, token, project.id, env.slug, key, placeholder);
      }
    }
  }

  return { projectId: project.id, createdProject };
}
