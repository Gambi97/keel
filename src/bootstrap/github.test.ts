import { describe, expect, it, vi } from 'vitest';

import { finalizeAnswers } from '../config.js';
import { configureEnvironments, type GitHubContext } from './github.js';

// staging + prod — the default preset.
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
    repo: 'app',
    repoPrivate: true,
  } as unknown as GitHubContext;
}

describe('configureEnvironments', () => {
  it('creates one plain environment per env — no reviewer gate, the tag is the gate', async () => {
    const calls: EnvParams[] = [];
    const createEnv = vi.fn(async (params: EnvParams) => {
      calls.push(params);
      return { data: {} };
    });

    await configureEnvironments(ctxWith(createEnv), answers);

    expect(calls.map((c) => c.environment_name)).toEqual(['staging', 'production']);
    // Required reviewers need a paid plan on private repos and would only
    // duplicate the tag gate: they must never be requested.
    for (const call of calls) {
      expect(call.reviewers).toBeUndefined();
    }
  });

  it('propagates environment-creation errors', async () => {
    const createEnv = vi.fn(async () => {
      throw Object.assign(new Error('HTTP 500'), { status: 500 });
    });
    await expect(configureEnvironments(ctxWith(createEnv), answers)).rejects.toThrow();
  });
});
