import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Octokit } from '@octokit/rest';

import type { Answers } from '../config.js';
import { planStatusCheckContext, type CiSecretName, type CiVariableName } from '../contracts.js';

// The ESM build of libsodium-wrappers is broken (missing libsodium.mjs), so
// load the CommonJS build explicitly.
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

/** Which input a validation failure points at, so prompts can re-ask just that. */
export type GitHubErrorField = 'token' | 'repo';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly field: GitHubErrorField = 'token',
  ) {
    super(message);
  }
}

export interface GitHubIdentity {
  octokit: Octokit;
  owner: string;
  ownerId: number;
}

export interface GitHubContext extends GitHubIdentity {
  repo: string;
  repoPrivate: boolean;
}

/**
 * Authenticate the token and confirm it carries the scopes keel needs. Split
 * from createContext so the prompt can validate the token and list the user's
 * repositories before a repository name even exists.
 */
export async function authenticate(token: string): Promise<GitHubIdentity> {
  // Silence Octokit's own request logging: expected non-2xx responses (a 404
  // for a repo that does not exist yet, a 401 for a bad token) are handled
  // here and would otherwise scribble over the prompt spinner.
  const octokit = new Octokit({
    auth: token,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
  let login: string;
  let ownerId: number;
  let scopes: string | undefined;
  try {
    const { data, headers } = await octokit.users.getAuthenticated();
    login = data.login;
    ownerId = data.id;
    scopes = headers['x-oauth-scopes'];
  } catch {
    throw new GitHubError(
      'GitHub rejected the token. It needs the "repo" and "workflow" scopes ' +
        '(classic PAT) or equivalent fine-grained permissions.',
    );
  }
  // Classic PATs advertise their scopes in a header; fine-grained tokens do
  // not, so an absent/empty header only means "cannot check here".
  if (scopes) {
    const granted = new Set(scopes.split(',').map((s) => s.trim()));
    for (const required of ['repo', 'workflow'] as const) {
      if (!granted.has(required)) {
        throw new GitHubError(
          `The GitHub token is missing the "${required}" scope (it has: ${scopes}). ` +
            'Create a classic PAT with the "repo" and "workflow" scopes.',
        );
      }
    }
  }
  return { octokit, owner: login, ownerId };
}

export async function createContext(
  github: Pick<Answers['github'], 'token' | 'repoName' | 'repoPrivate'>,
): Promise<GitHubContext> {
  const identity = await authenticate(github.token);
  return { ...identity, repo: github.repoName, repoPrivate: github.repoPrivate };
}

export interface OwnedRepo {
  name: string;
  private: boolean;
  /** No content yet (GitHub reports size 0): keel can push into it. */
  empty: boolean;
}

/**
 * Repositories the user owns, newest first, flagged by emptiness. keel pushes a
 * brand-new history, so only empty repos are reusable; `size === 0` is GitHub's
 * cheap proxy for "no commits" (inspectRepo makes the authoritative call once a
 * name is chosen). Paginated in full — the picker never silently truncates.
 */
export async function listOwnedRepos(octokit: Octokit): Promise<OwnedRepo[]> {
  const repos = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
    affiliation: 'owner',
    sort: 'updated',
    per_page: 100,
  });
  return repos.map((r) => ({ name: r.name, private: r.private, empty: r.size === 0 }));
}

export type RepoState = 'not-found' | 'empty' | 'non-empty' | 'no-push';

/** Read-only look at the target repository: existence, push access, emptiness. */
export async function inspectRepo(ctx: GitHubContext): Promise<{ state: RepoState; url?: string }> {
  let url: string;
  try {
    const { data } = await ctx.octokit.repos.get({ owner: ctx.owner, repo: ctx.repo });
    if (!data.permissions?.push) return { state: 'no-push', url: data.html_url };
    url = data.html_url;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return { state: 'not-found' };
    throw error;
  }
  try {
    const { data } = await ctx.octokit.repos.listCommits({
      owner: ctx.owner,
      repo: ctx.repo,
      per_page: 1,
    });
    return { state: data.length > 0 ? 'non-empty' : 'empty', url };
  } catch (error) {
    // GitHub answers 409 "Git Repository is empty" for a repo with no commits.
    if ((error as { status?: number }).status === 409) return { state: 'empty', url };
    throw error;
  }
}

/** Turn a blocking repo state into a GitHubError; pass on 'not-found'/'empty'. */
export function assertRepoUsable(ctx: GitHubContext, state: RepoState): void {
  if (state === 'no-push') {
    throw new GitHubError(
      `Repository ${ctx.owner}/${ctx.repo} exists but the token cannot push to it.`,
      'repo',
    );
  }
  if (state === 'non-empty') {
    throw new GitHubError(
      `Repository ${ctx.owner}/${ctx.repo} already has commits. keel pushes a brand-new ` +
        'history, so the push would be rejected: use a new repository name (keel creates ' +
        'it for you) or an existing repository with no commits.',
      'repo',
    );
  }
}

/** Create the repository, or reuse it when it already exists and is empty. */
export async function ensureRepo(ctx: GitHubContext): Promise<{ created: boolean; url: string }> {
  const inspected = await inspectRepo(ctx);
  assertRepoUsable(ctx, inspected.state);
  if (inspected.state !== 'not-found') {
    return { created: false, url: inspected.url! };
  }
  try {
    const { data } = await ctx.octokit.repos.createForAuthenticatedUser({
      name: ctx.repo,
      private: ctx.repoPrivate,
      description: 'Serverless infrastructure on Scaleway, generated by keel',
      has_wiki: false,
      has_projects: false,
      auto_init: false,
    });
    return { created: true, url: data.html_url };
  } catch (error) {
    // inspectRepo said 404 but creation says the name is taken: a fine-grained
    // token that cannot see the existing repo answers exactly this way. Map it
    // to a re-askable error instead of dying on a raw Octokit failure.
    if ((error as { status?: number }).status === 422) {
      throw new GitHubError(
        `Repository ${ctx.owner}/${ctx.repo} already exists but the token cannot see it ` +
          '(fine-grained tokens only see the repositories they were granted). Use a token ' +
          'with access to it, or a different repository name.',
        'repo',
      );
    }
    throw error;
  }
}

/**
 * Push the generated repo over HTTPS. The token is handed to git through a
 * temporary GIT_ASKPASS helper reading an environment variable, so it never
 * appears in the remote URL, in .git/config or in the process list.
 */
export function pushRepo(ctx: GitHubContext, token: string, targetDir: string): void {
  const remoteUrl = `https://github.com/${ctx.owner}/${ctx.repo}.git`;
  const askpassDir = mkdtempSync(join(tmpdir(), 'keel-askpass-'));
  const askpass = join(askpassDir, 'askpass.sh');
  writeFileSync(askpass, '#!/bin/sh\necho "$KEEL_GIT_TOKEN"\n');
  chmodSync(askpass, 0o700);
  try {
    const git = (args: string[]) =>
      spawnSync('git', args, {
        cwd: targetDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_ASKPASS: askpass,
          KEEL_GIT_TOKEN: token,
          GIT_TERMINAL_PROMPT: '0',
        },
      });
    git(['remote', 'remove', 'origin']);
    const addRemote = git(['remote', 'add', 'origin', remoteUrl]);
    if (addRemote.status !== 0) {
      throw new GitHubError(`git remote add failed: ${addRemote.stderr.toString().trim()}`);
    }
    // The remote embeds the username only; the password comes from askpass.
    const setUser = git(['config', 'credential.username', 'x-access-token']);
    if (setUser.status !== 0) {
      throw new GitHubError(`git config failed: ${setUser.stderr.toString().trim()}`);
    }
    const push = git(['push', '-u', 'origin', 'main']);
    if (push.status !== 0) {
      throw new GitHubError(`git push failed: ${push.stderr.toString().trim()}`);
    }
  } finally {
    rmSync(askpassDir, { recursive: true, force: true });
  }
}

/**
 * Encrypt and upload every CI secret, then set the plain variables. Returns a
 * warning instead of failing when branch protection is unavailable.
 */
export async function configureRepo(
  ctx: GitHubContext,
  answers: Answers,
  infisicalProjectId: string,
): Promise<string | undefined> {
  // The workflows map AWS_* (state backend) from the same SCW_* secrets, so
  // each credential is stored once and rotated in one place. The Record types
  // force these names to stay in lockstep with the contracts the generated
  // workflows are tested against.
  const secrets: Record<CiSecretName, string> = {
    SCW_ACCESS_KEY: answers.scaleway.accessKey,
    SCW_SECRET_KEY: answers.scaleway.secretKey,
    SCW_DEFAULT_PROJECT_ID: answers.scaleway.projectId,
    SCW_DEFAULT_ORGANIZATION_ID: answers.scaleway.organizationId,
    INFISICAL_CLIENT_ID: answers.infisical.clientId,
    INFISICAL_CLIENT_SECRET: answers.infisical.clientSecret,
  };
  await setSecrets(ctx, secrets);
  const variables: Record<CiVariableName, string> = {
    TF_STATE_BUCKET: answers.stateBucket,
    SCW_REGION: answers.region,
    INFISICAL_PROJECT_ID: infisicalProjectId,
    INFISICAL_HOST: answers.infisical.host,
  };
  await setVariables(ctx, variables);
  const warnings = [
    await configureEnvironments(ctx, answers),
    await protectMainBranch(ctx, answers),
  ].filter((w): w is string => w !== undefined);
  return warnings.length > 0 ? warnings.join('\n\n') : undefined;
}

async function setSecrets(ctx: GitHubContext, secrets: Record<string, string>): Promise<void> {
  await sodium.ready;
  const { data: key } = await ctx.octokit.actions.getRepoPublicKey({
    owner: ctx.owner,
    repo: ctx.repo,
  });
  for (const [name, value] of Object.entries(secrets)) {
    const sealed = sodium.crypto_box_seal(
      sodium.from_string(value),
      sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL),
    );
    await ctx.octokit.actions.createOrUpdateRepoSecret({
      owner: ctx.owner,
      repo: ctx.repo,
      secret_name: name,
      encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
      key_id: key.key_id,
    });
  }
}

async function setVariables(ctx: GitHubContext, variables: Record<string, string>): Promise<void> {
  for (const [name, value] of Object.entries(variables)) {
    try {
      await ctx.octokit.actions.createRepoVariable({
        owner: ctx.owner,
        repo: ctx.repo,
        name,
        value,
      });
    } catch (error) {
      if ((error as { status?: number }).status !== 409) throw error;
      await ctx.octokit.actions.updateRepoVariable({
        owner: ctx.owner,
        repo: ctx.repo,
        name,
        value,
      });
    }
  }
}

/**
 * Each environment gets a GitHub deployment environment; gated ones (prod)
 * require a reviewer approval. Required reviewers need GitHub Enterprise Cloud
 * on private repositories — GitHub answers 422 there. Rather than strand the
 * bootstrap at its last step, fall back to an ungated environment and warn:
 * the environment still exists (deployments target it) but production will
 * auto-deploy on merge. Like the branch-protection miss, this degrades to a
 * warning instead of killing the run.
 */
export async function configureEnvironments(
  ctx: GitHubContext,
  answers: Answers,
): Promise<string | undefined> {
  const ungated: string[] = [];
  for (const env of answers.environments) {
    try {
      await ctx.octokit.repos.createOrUpdateEnvironment({
        owner: ctx.owner,
        repo: ctx.repo,
        environment_name: env.githubEnvironment,
        ...(env.gated ? { reviewers: [{ type: 'User', id: ctx.ownerId }] } : {}),
      });
    } catch (error) {
      // Only the reviewer rule can trip the plan limit; re-throw anything else
      // (and any failure on a non-gated environment, which asked for no rule).
      if (!env.gated || (error as { status?: number }).status !== 422) throw error;
      await ctx.octokit.repos.createOrUpdateEnvironment({
        owner: ctx.owner,
        repo: ctx.repo,
        environment_name: env.githubEnvironment,
      });
      ungated.push(env.githubEnvironment);
    }
  }
  if (ungated.length === 0) return undefined;
  return (
    `Created the ${ungated.join(', ')} environment(s) without the manual-approval gate: ` +
    'required reviewers need GitHub Enterprise Cloud on private repositories, so production ' +
    'will auto-deploy on merge to main. Make the repository public (reviewers are free there) ' +
    'or upgrade the plan, then re-run to add the gate.'
  );
}

/**
 * Require a green plan on PRs and forbid force-pushes/deletion of main.
 * Branch protection needs GitHub Pro on private repositories: failing here
 * would strand the bootstrap at its very last step with everything else
 * already created, so — like the state bucket policy — the miss degrades to
 * a warning instead of killing the run.
 */
async function protectMainBranch(
  ctx: GitHubContext,
  answers: Answers,
): Promise<string | undefined> {
  try {
    await ctx.octokit.repos.updateBranchProtection({
      owner: ctx.owner,
      repo: ctx.repo,
      branch: 'main',
      required_status_checks: {
        strict: false,
        // Must match the job names produced by the plan workflow; the shared
        // format lives in contracts.ts and is tested against the template.
        contexts: answers.environments.map((env) => planStatusCheckContext(env.slug)),
      },
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    });
    return undefined;
  } catch (error) {
    if ((error as { status?: number }).status !== 403) throw error;
    return (
      `Could not protect the main branch of ${ctx.owner}/${ctx.repo}: GitHub requires a ` +
      'paid plan for branch protection on private repositories. PRs stay mergeable without ' +
      'a green plan — make the repository public or upgrade, then re-run to add protection.'
    );
  }
}
