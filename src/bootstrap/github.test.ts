import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { finalizeAnswers } from '../config.js';
import { configureEnvironments, detectOrigin, getOriginUrl, type GitHubContext } from './github.js';

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

describe('detectOrigin / getOriginUrl', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const initWithOrigin = (url?: string): string => {
    const d = mkdtempSync(join(tmpdir(), 'keel-origin-'));
    execSync('git init -q -b main', { cwd: d });
    if (url) execSync(`git remote add origin ${url}`, { cwd: d });
    return d;
  };

  it('parses https and ssh github URLs, with or without the .git suffix', () => {
    for (const url of [
      'https://github.com/Me/My_Repo.git',
      'git@github.com:Me/My_Repo.git',
      'https://github.com/Me/My_Repo',
    ]) {
      dir = initWithOrigin(url);
      expect(detectOrigin(dir), url).toEqual({ owner: 'Me', repo: 'My_Repo' });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined for no origin and for non-github origins', () => {
    dir = initWithOrigin();
    expect(detectOrigin(dir)).toBeUndefined();
    expect(getOriginUrl(dir)).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });

    // A remote keel cannot target: getOriginUrl still sees it, detectOrigin does
    // not — that gap is what the caller turns into a "remove this origin" error.
    dir = initWithOrigin('git@gitlab.com:me/repo.git');
    expect(detectOrigin(dir)).toBeUndefined();
    expect(getOriginUrl(dir)).toBe('git@gitlab.com:me/repo.git');
  });
});
