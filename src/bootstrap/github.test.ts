import { describe, expect, it, vi } from 'vitest';

import { finalizeAnswers } from '../config.js';
import { configureEnvironments, type GitHubContext } from './github.js';

// staging (ungated) + prod (gated) — the default preset.
const answers = finalizeAnswers({
  projectName: 'demo-app',
  scaleway: { accessKey: 'a', secretKey: 's', projectId: 'p', organizationId: 'o' },
  infisical: { clientId: 'c', clientSecret: 's' },
  github: { token: 't' },
  scaling: {},
});

interface EnvParams {
  environment_name: string;
  reviewers?: unknown;
}

function ctxWith(createEnv: (params: EnvParams) => Promise<unknown>): GitHubContext {
  return {
    octokit: { repos: { createOrUpdateEnvironment: createEnv } },
    owner: 'me',
    ownerId: 1,
    repo: 'app',
    repoPrivate: true,
  } as unknown as GitHubContext;
}

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe('configureEnvironments', () => {
  it('falls back to an ungated environment when required reviewers need a paid plan (422)', async () => {
    const calls: EnvParams[] = [];
    const createEnv = vi.fn(async (params: EnvParams) => {
      calls.push(params);
      // GitHub rejects required reviewers on private repos below Enterprise.
      if (params.reviewers) throw httpError(422);
      return { data: {} };
    });

    const warning = await configureEnvironments(ctxWith(createEnv), answers);

    expect(warning).toMatch(/without the manual-approval gate/);
    // production is retried without the reviewer rule; staging is untouched.
    const prod = calls.filter((c) => c.environment_name === 'production');
    expect(prod).toHaveLength(2);
    expect(prod[0]?.reviewers).toBeDefined();
    expect(prod[1]?.reviewers).toBeUndefined();
  });

  it('rethrows errors that are not the 422 plan limit', async () => {
    const createEnv = vi.fn(async () => {
      throw httpError(500);
    });
    await expect(configureEnvironments(ctxWith(createEnv), answers)).rejects.toThrow();
  });

  it('returns no warning when every environment is created cleanly', async () => {
    const createEnv = vi.fn(async () => ({ data: {} }));
    expect(await configureEnvironments(ctxWith(createEnv), answers)).toBeUndefined();
  });
});
