import { beforeEach, describe, expect, it, vi } from 'vitest';

// Record every prompt shown, and answer by matching the message text. This
// lets the tests assert the *order* of questions and drive the re-prompt loop.
const asked: string[] = [];
let answer: (message: string) => unknown;

vi.mock('@clack/prompts', () => {
  const record = (opts: { message: string }) => {
    asked.push(opts.message);
    return Promise.resolve(answer(opts.message));
  };
  return {
    text: record,
    password: record,
    select: record,
    confirm: record,
    note: () => {},
    intro: () => {},
    outro: () => {},
    isCancel: () => false,
    cancel: () => {},
    log: { step: () => {}, success: () => {}, error: () => {}, info: () => {} },
    spinner: () => ({ start: () => {}, stop: () => {} }),
  };
});

vi.mock('./ui.js', () => ({
  log: { step: () => {}, success: () => {}, error: () => {}, info: () => {}, warn: () => {} },
  withSpinner: (_label: string, fn: () => unknown) => fn(),
}));

vi.mock('./state.js', () => ({
  isDone: () => false,
  loadState: () => ({ version: 1, projectName: 'x', steps: {} }),
}));

// Keep the real error classes; stub only the network-touching functions.
const gh = vi.hoisted(() => ({
  inspectRepo: vi.fn(),
  createContext: vi.fn(),
  authenticate: vi.fn(),
  listOwnedRepos: vi.fn(),
}));
vi.mock('./bootstrap/github.js', async (orig) => ({
  ...(await orig<typeof import('./bootstrap/github.js')>()),
  createContext: gh.createContext,
  inspectRepo: gh.inspectRepo,
  authenticate: gh.authenticate,
  listOwnedRepos: gh.listOwnedRepos,
}));

const inf = vi.hoisted(() => ({ validateInfisical: vi.fn() }));
vi.mock('./bootstrap/infisical.js', async (orig) => ({
  ...(await orig<typeof import('./bootstrap/infisical.js')>()),
  validateInfisical: inf.validateInfisical,
}));

const scw = vi.hoisted(() => ({ validateScalewayCredentials: vi.fn() }));
vi.mock('./bootstrap/scaleway.js', async (orig) => ({
  ...(await orig<typeof import('./bootstrap/scaleway.js')>()),
  validateScalewayCredentials: scw.validateScalewayCredentials,
}));

import { fillMissing } from './prompts.js';
import { GitHubError } from './bootstrap/github.js';

/** Default happy-path answers, keyed by a substring of the prompt message. */
function happyAnswer(message: string): unknown {
  if (message.includes('Project name')) return 'my-app';
  if (message.includes('environments')) return 'staging+prod';
  if (message.includes('Container resources')) return '500m';
  if (message.includes('Object Storage')) return false;
  if (message.includes('Basic Auth')) return true;
  if (message.includes('production instances')) return '1';
  if (message.includes('repository name')) return 'my-app';
  if (message.includes('visibility')) return false;
  if (message.includes('GitHub token')) return 'ghp_token';
  if (message.includes('Infisical host')) return 'us';
  if (message.includes('client ID')) return 'cid';
  if (message.includes('client secret')) return 'csecret';
  if (message.includes('project ID to reuse')) return '';
  if (message.includes('Scaleway region')) return 'fr-par';
  if (message.includes('access key')) return 'ak';
  if (message.includes('secret key')) return 'sk';
  if (message.includes('project ID')) return 'pid';
  if (message.includes('organization ID')) return 'oid';
  throw new Error(`Unexpected prompt: ${message}`);
}

const empty = () => ({ scaleway: {}, infisical: {}, github: {}, scaling: {} });

beforeEach(() => {
  vi.clearAllMocks();
  asked.length = 0;
  answer = happyAnswer;
  gh.createContext.mockResolvedValue({ owner: 'me', repo: 'my-app' });
  gh.inspectRepo.mockResolvedValue({ state: 'not-found' });
  gh.authenticate.mockResolvedValue({ octokit: {}, owner: 'me', ownerId: 1 });
  gh.listOwnedRepos.mockResolvedValue([]); // no reusable repos → type a new name
  inf.validateInfisical.mockResolvedValue({});
  scw.validateScalewayCredentials.mockResolvedValue({});
});

describe('fillMissing question order', () => {
  it('asks the name, then GitHub, Infisical, Scaleway, then configuration', async () => {
    await fillMissing(empty(), { advanced: false });

    const idx = (needle: string) => asked.findIndex((m) => m.includes(needle));
    // Name first, then the three provider blocks in order.
    expect(idx('Project name')).toBeLessThan(idx('repository name'));
    expect(idx('GitHub token')).toBeLessThan(idx('Infisical host'));
    expect(idx('client secret')).toBeLessThan(idx('access key'));
    // Configuration (region, environments) comes after every provider block.
    expect(idx('access key')).toBeLessThan(idx('Scaleway region'));
    expect(idx('access key')).toBeLessThan(idx('environments'));
  });

  it('validates each provider exactly once on the happy path', async () => {
    await fillMissing(empty(), { advanced: false });
    expect(gh.createContext).toHaveBeenCalledTimes(1);
    expect(inf.validateInfisical).toHaveBeenCalledTimes(1);
    expect(scw.validateScalewayCredentials).toHaveBeenCalledTimes(1);
  });

  it('skips every provider block in dry-run but still asks the region', async () => {
    await fillMissing(empty(), { advanced: false, dryRun: true });
    expect(asked.some((m) => m.includes('GitHub token'))).toBe(false);
    expect(asked.some((m) => m.includes('Scaleway region'))).toBe(true);
    expect(gh.createContext).not.toHaveBeenCalled();
  });
});

describe('fillMissing re-prompt loop', () => {
  it('re-asks only the repository name when the repo is not usable', async () => {
    // First inspection reports a non-empty repo (blocking); second is clean.
    gh.inspectRepo
      .mockResolvedValueOnce({ state: 'non-empty' })
      .mockResolvedValue({ state: 'not-found' });

    await fillMissing(empty(), { advanced: false });

    const repoAsks = asked.filter((m) => m.includes('repository name')).length;
    const tokenAsks = asked.filter((m) => m.includes('GitHub token')).length;
    expect(repoAsks).toBe(2); // asked again after the failure
    expect(tokenAsks).toBe(1); // token was fine, not re-asked
  });

  it('picks an existing empty repo from the list without asking for a name', async () => {
    gh.listOwnedRepos.mockResolvedValue([
      { name: 'spare-repo', private: true, empty: true },
      { name: 'has-code', private: false, empty: false },
    ]);
    answer = (message: string) => {
      if (message === 'Repository') return 'spare-repo'; // pick from the selector
      return happyAnswer(message);
    };

    const out = await fillMissing(empty(), { advanced: false });

    // The selector was shown, and no "New repository name" text prompt appeared.
    expect(asked).toContain('Repository');
    expect(asked.some((m) => m.includes('New repository name'))).toBe(false);
    expect(out.github.repoName).toBe('spare-repo');
    // Reused repo keeps its own visibility, so the question is skipped.
    expect(out.github.repoPrivate).toBe(true);
    expect(asked.some((m) => m.includes('visibility'))).toBe(false);
  });

  it('re-asks the token when GitHub rejects it', async () => {
    let attempt = 0;
    gh.createContext.mockImplementation(() => {
      if (attempt++ === 0) throw new GitHubError('bad token'); // field defaults to 'token'
      return Promise.resolve({ owner: 'me', repo: 'my-app' });
    });

    await fillMissing(empty(), { advanced: false });

    const repoAsks = asked.filter((m) => m.includes('repository name')).length;
    const tokenAsks = asked.filter((m) => m.includes('GitHub token')).length;
    expect(tokenAsks).toBe(2); // token re-asked
    expect(repoAsks).toBe(1); // repo name kept
  });
});
