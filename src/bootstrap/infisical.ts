import { randomBytes } from 'node:crypto';

import type { Answers } from '../config.js';
import { BASE_SYNCED_KEYS, BASIC_AUTH_SECRET_KEYS, S3_SECRET_KEYS } from '../contracts.js';

/** Which input a validation failure points at, so prompts can re-ask just that. */
export type InfisicalErrorField = 'credentials' | 'project';

export class InfisicalError extends Error {
  constructor(
    message: string,
    readonly field: InfisicalErrorField = 'credentials',
  ) {
    super(message);
  }
}

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

export async function login(
  infisical: Pick<Answers['infisical'], 'host' | 'clientId' | 'clientSecret'>,
): Promise<string> {
  const { host, clientId, clientSecret } = infisical;
  const { status, data } = await api<{ accessToken?: string; message?: string }>(
    host,
    '/api/v1/auth/universal-auth/login',
    { method: 'POST', body: { clientId, clientSecret } },
  );
  if (status !== 200 || !data.accessToken) {
    // A usage-limited client secret is a trap for this setup: besides the
    // bootstrap, CI logs in with it on every plan/apply, so any finite limit
    // eventually runs out. Name the fix instead of a generic "check secret".
    const remediation = /usage limit/i.test(data.message ?? '')
      ? 'This client secret was created with a usage limit and it is spent. Create a new one ' +
        'with unlimited uses (Max Number of Uses = 0): CI logs in with it on every plan/apply, ' +
        'so a limited secret will always run out.'
      : 'Check the machine identity client ID/secret and that Universal Auth is enabled.';
    throw new InfisicalError(
      `Infisical Universal Auth login failed (HTTP ${status}${data.message ? `: ${data.message}` : ''}). ${remediation}`,
    );
  }
  return data.accessToken;
}

async function listProjects(host: string, token: string): Promise<InfisicalProject[]> {
  const { status, data } = await api<{ workspaces?: InfisicalProject[] }>(
    host,
    '/api/v1/workspace',
    { token },
  );
  if (status !== 200) return [];
  return data.workspaces ?? [];
}

async function findProject(
  host: string,
  token: string,
  name: string,
): Promise<InfisicalProject | undefined> {
  return (await listProjects(host, token)).find((w) => w.name === name);
}

/** Look an existing project up by ID among those the identity can access. */
export async function findProjectById(
  host: string,
  token: string,
  id: string,
): Promise<InfisicalProject | undefined> {
  return (await listProjects(host, token)).find((w) => w.id === id);
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
  if (status === 200) return;
  // A 400 usually means the environment already exists (fine for idempotency),
  // but it is also what plan limits and rejected slugs answer: trust the
  // message when it says "exists", otherwise re-fetch and check for real —
  // swallowing it blindly would surface later as a confusing seeding failure.
  if (status === 400) {
    if (/exist/i.test(data.message ?? '')) return;
    const fresh = await findProjectById(host, token, project.id);
    if (fresh?.environments?.some((e) => e.slug === slug)) return;
  }
  throw new InfisicalError(
    `Could not create Infisical environment "${slug}" (HTTP ${status}${data.message ? `: ${data.message}` : ''}).`,
  );
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

function inaccessibleProject(projectId: string): InfisicalError {
  return new InfisicalError(
    `Infisical project "${projectId}" was not found or the machine identity has no access to it. ` +
      'Check the project ID and that the identity is a member of the project.',
    'project',
  );
}

/**
 * Read-only validation: Universal Auth login works and, when a project ID was
 * given, that project is accessible. Returns the project name when found.
 */
export async function validateInfisical(
  infisical: Pick<Answers['infisical'], 'host' | 'clientId' | 'clientSecret' | 'projectId'>,
): Promise<{ projectName?: string }> {
  const token = await login(infisical);
  if (infisical.projectId) {
    const project = await findProjectById(infisical.host, token, infisical.projectId);
    if (!project) throw inaccessibleProject(infisical.projectId);
    return { projectName: project.name };
  }
  return {};
}

/**
 * Delete the project (teardown). Resolved by ID when one is known — the
 * recorded one from .keel.json or an explicit flag — and by exact name
 * otherwise, mirroring the find-or-create of the bootstrap. Absent is a valid
 * outcome so a re-run never fails on work already done.
 *
 * When ownership is unknown (no bootstrap record), a project reached by ID
 * whose name is not the expected one is answered 'kept': keel's own default
 * creation names the project after the app, so a differently-named project
 * is a reused one keel must not destroy.
 */
export async function deleteProject(
  infisical: Pick<
    Answers['infisical'],
    'host' | 'clientId' | 'clientSecret' | 'projectName' | 'projectId'
  >,
): Promise<'deleted' | 'absent' | 'kept'> {
  const token = await login(infisical);
  const existing = infisical.projectId
    ? await findProjectById(infisical.host, token, infisical.projectId)
    : await findProject(infisical.host, token, infisical.projectName);
  if (!existing) return 'absent';
  if (infisical.projectId && existing.name !== infisical.projectName) {
    return 'kept';
  }
  const { status, data } = await api<{ message?: string }>(
    infisical.host,
    `/api/v1/workspace/${existing.id}`,
    { method: 'DELETE', token },
  );
  if (status !== 200) {
    throw new InfisicalError(
      `Could not delete Infisical project "${existing.name}" (HTTP ${status}${data.message ? `: ${data.message}` : ''}). ` +
        'The machine identity needs admin access to the project.',
    );
  }
  return 'deleted';
}

/** Create/reuse the project, ensure every environment, seed placeholder secrets. */
export async function bootstrapInfisical(answers: Answers): Promise<InfisicalBootstrapResult> {
  const { host, projectName, projectId } = answers.infisical;
  const token = await login(answers.infisical);

  let createdProject = false;
  let project: InfisicalProject | undefined;
  if (projectId) {
    // An explicit ID is never created implicitly: fail loudly if unreachable.
    project = await findProjectById(host, token, projectId);
    if (!project) throw inaccessibleProject(projectId);
  } else {
    // Find-by-name keeps re-runs idempotent even without a recorded ID.
    project = await findProject(host, token, projectName);
    if (!project) {
      project = await createProject(host, token, projectName);
      createdProject = true;
    }
  }

  for (const env of answers.environments) {
    await ensureEnvironment(host, token, project, env.slug, env.displayName);
  }

  // Real values arrive from the pipeline after the first apply; seed placeholders
  // now so the secret paths exist and the container has something to read.
  const placeholder = 'placeholder-updated-by-pipeline-after-first-apply';
  for (const env of answers.environments) {
    if (env.basicAuth) {
      const [userKey, passwordKey] = BASIC_AUTH_SECRET_KEYS;
      await seedSecret(host, token, project.id, env.slug, userKey, env.slug);
      await seedSecret(
        host,
        token,
        project.id,
        env.slug,
        passwordKey,
        randomBytes(18).toString('base64url'),
      );
    }
    for (const key of BASE_SYNCED_KEYS) {
      await seedSecret(host, token, project.id, env.slug, key, placeholder);
    }
    if (answers.objectStorage) {
      for (const key of S3_SECRET_KEYS) {
        await seedSecret(host, token, project.id, env.slug, key, placeholder);
      }
    }
  }

  return { projectId: project.id, createdProject };
}
