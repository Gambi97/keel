import * as p from '@clack/prompts';

import {
  authenticate,
  createContext,
  type GitHubIdentity,
  GitHubError,
  inspectRepo,
  assertRepoUsable,
  listOwnedRepos,
} from './bootstrap/github.js';
import { InfisicalError, validateInfisical } from './bootstrap/infisical.js';
import { ScalewayError, validateScalewayCredentials } from './bootstrap/scaleway.js';
import {
  ConfigError,
  DEFAULT_ENV_PRESET,
  DEFAULT_INFISICAL_HOST,
  DEFAULT_REGION,
  ENV_PRESETS,
  envDefaultScale,
  hydrateConfigFromManifest,
  type EnvSlug,
  REGIONS,
  type PartialAnswers,
  validateProjectName,
  validateScale,
  validateUrl,
} from './config.js';
import { readManifest } from './generate.js';
import { isDone, loadState } from './state.js';
import { log } from './ui.js';

function bail(): never {
  p.cancel('Cancelled. Nothing was created.');
  process.exit(1);
}

async function ask<T>(promise: Promise<T | symbol>): Promise<T> {
  const value = await promise;
  if (p.isCancel(value)) bail();
  return value as T;
}

function validate(fn: (value: string) => unknown): (value: string) => string | undefined {
  return (value) => {
    try {
      fn(value);
      return undefined;
    } catch (error) {
      return error instanceof ConfigError ? error.message : 'Invalid value.';
    }
  };
}

const secret = (message: string) => ask(p.password({ message }));
const text = (message: string, placeholder?: string) =>
  ask(
    p.text({
      message,
      ...(placeholder ? { placeholder } : {}),
      validate: (v) => (v.trim() ? undefined : 'Required.'),
    }),
  );

export interface FillOptions {
  advanced: boolean;
  /** Dry run: skip credential questions and provider validation entirely. */
  dryRun?: boolean;
}

/**
 * Interactively fill everything still missing from flags/env/config file.
 *
 * The project name comes first (it seeds the repo/bucket/project defaults),
 * then the three provider blocks (GitHub, Infisical, Scaleway) — each closed
 * by a read-only validation call that reports bad input immediately and
 * re-asks only the offending value — and finally the configuration you want
 * (region, environments, storage, scaling). Nothing is created here; creation
 * starts only after the final confirmation.
 */
export async function fillMissing(
  partial: PartialAnswers,
  options: FillOptions,
): Promise<PartialAnswers> {
  const out = structuredClone(partial);

  await askProjectName(out);

  // Resuming an existing project: its configuration is frozen (the repo is
  // already generated with it), so lock it from the committed manifest instead
  // of asking again. Credentials are never persisted, so the provider blocks
  // still run — set SCW_*/INFISICAL_*/GITHUB_TOKEN in the env to skip typing.
  const resumeDir = out.targetDir?.trim() || out.projectName!;
  const manifest = readManifest(resumeDir);
  const resuming = manifest !== undefined && manifest.projectName === out.projectName;
  if (manifest && resuming) {
    hydrateConfigFromManifest(out, manifest);
    log.info(
      `Resuming "${out.projectName}" — region, environments and options are locked to its .keel manifest.`,
    );
  }

  // Each block opens with a "┌ <Provider>" section corner and closes with a
  // "└ <Provider> connected — …" line, so every question flows inside its own
  // section and the next one opens only when the previous is verified.
  if (!options.dryRun) {
    await askGitHub(out);
    await askInfisical(out);
    await askScaleway(out);
  }
  // Configuration comes last: with the accounts verified, these are the only
  // real choices left. In a dry run it is all that is asked after the name.
  // On resume it is skipped entirely — the manifest already fixed it.
  if (!resuming) {
    await askConfiguration(out, options);
  }

  return out;
}

async function askProjectName(out: PartialAnswers): Promise<void> {
  if (out.projectName) return;
  out.projectName = await ask(
    p.text({
      message: 'Project name (dns-safe, used for repo, bucket and resources)',
      placeholder: 'my-app',
      validate: validate(validateProjectName),
    }),
  );
}

/** Everything that shapes the infrastructure: region, environments, options. */
async function askConfiguration(out: PartialAnswers, options: FillOptions): Promise<void> {
  p.intro('Configuration — region, environments and options');
  await askRegion(out);

  if (!out.environments || out.environments.length === 0) {
    const preset = await ask(
      p.select({
        message: 'Which environments do you want?',
        initialValue: DEFAULT_ENV_PRESET,
        options: [
          { value: 'prod', label: 'Production only', hint: 'single environment' },
          { value: 'staging+prod', label: 'Staging + Production', hint: 'recommended' },
          { value: 'dev+staging+prod', label: 'Dev + Staging + Production' },
        ],
      }),
    );
    out.environments = ENV_PRESETS[preset];
  }
  const slugs = out.environments as EnvSlug[];
  const hasNonProd = slugs.some((s) => s !== 'prod');

  if (out.objectStorage === undefined) {
    out.objectStorage = await ask(
      p.confirm({
        message:
          'Provision an Object Storage bucket for application files (in addition to the database)?',
        initialValue: false,
      }),
    );
  }

  if (hasNonProd && out.basicAuth === undefined) {
    out.basicAuth = await ask(
      p.confirm({
        message: 'Protect non-production environments with Basic Auth (enforced by your app)?',
        initialValue: true,
      }),
    );
  }

  // Production is the one scaling knob worth surfacing at setup: everything
  // scales to zero when idle, and this is the ceiling. Staging/dev stay 0-1;
  // full per-environment control lives behind --advanced.
  if (!options.advanced && slugs.includes('prod') && out.scaling.prod?.maxScale === undefined) {
    const max = await ask(
      p.text({
        message: 'Maximum production instances (idle scales to zero; raise later in prod.tfvars)',
        initialValue: String(envDefaultScale('prod').maxScale),
        validate: validate((v) => validateScale(v, 'prod max scale')),
      }),
    );
    out.scaling.prod = { ...(out.scaling.prod ?? {}), maxScale: Number(max) };
  }

  if (options.advanced) {
    const scale = async (message: string, initial: number) =>
      Number(
        await ask(
          p.text({
            message,
            initialValue: String(initial),
            validate: validate((v) => validateScale(v, 'scale')),
          }),
        ),
      );
    for (const slug of slugs) {
      const def = envDefaultScale(slug);
      const current = out.scaling[slug] ?? {};
      current.minScale = await scale(`${slug} min scale`, current.minScale ?? def.minScale);
      current.maxScale = await scale(`${slug} max scale`, current.maxScale ?? def.maxScale);
      out.scaling[slug] = current;
    }
  }
}

/**
 * Decide the target repository once the token is known: create a new one, or
 * reuse an existing empty repo picked from a list. keel pushes a brand-new
 * history, so only empty repos are offered — a name typed for a new repo is
 * still validated. Sets repoName (and, for an existing pick, its real
 * visibility) on `out`.
 */
async function chooseRepo(out: PartialAnswers, identity: GitHubIdentity): Promise<void> {
  const CREATE_NEW = ' create-new'; // sentinel: a leading space is never a valid repo name
  const spin = p.spinner();
  spin.start('Fetching your GitHub repositories');
  let reusable: Awaited<ReturnType<typeof listOwnedRepos>> = [];
  try {
    const repos = await listOwnedRepos(identity.octokit);
    reusable = repos.filter((r) => r.empty);
    spin.stop(
      reusable.length
        ? `Found ${reusable.length} empty repositor${reusable.length === 1 ? 'y' : 'ies'} you can reuse`
        : 'No empty repositories to reuse — keel will create a new one',
    );
  } catch {
    spin.stop('Could not list repositories; you can still name a new one');
  }

  const choice = reusable.length
    ? await ask(
        p.select({
          message: 'Repository',
          initialValue: CREATE_NEW,
          options: [
            {
              value: CREATE_NEW,
              label: 'Create a new repository',
              hint: 'keel creates it for you',
            },
            ...reusable.map((r) => ({
              value: r.name,
              label: r.name,
              hint: `${r.private ? 'private' : 'public'}, empty — reuse it`,
            })),
          ],
        }),
      )
    : CREATE_NEW;

  if (choice !== CREATE_NEW) {
    const picked = reusable.find((r) => r.name === choice)!;
    out.github.repoName = picked.name;
    out.github.repoPrivate = picked.private; // keep the repo's existing visibility
    return;
  }

  out.github.repoName = await ask(
    p.text({
      message: 'New repository name',
      initialValue: out.projectName,
      validate: validate(validateProjectName),
    }),
  );
}

/** GitHub block: token first (so we can list repos), then repo choice and state. */
async function askGitHub(out: PartialAnswers): Promise<void> {
  // When resuming a run that already pushed, the repo legitimately has
  // commits: a non-empty repo must not block the resume.
  const targetDir = out.targetDir?.trim() || out.projectName!;
  const alreadyPushed = isDone(loadState(targetDir, out.projectName!), 'github-push');

  p.intro('GitHub — token, repository and visibility');
  for (;;) {
    // Token first: authenticating up front lets keel list your repositories so
    // you can pick one instead of typing its name.
    if (!out.github.token) {
      out.github.token = await secret('GitHub token (scopes: repo, workflow)');
    }
    let identity: GitHubIdentity;
    try {
      identity = await authenticate(out.github.token!);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      log.error(error.message);
      out.github.token = undefined;
      continue;
    }

    // New-or-existing selector. Skipped when a name is already fixed by flags,
    // --config or a resumed run.
    if (!out.github.repoName) {
      await chooseRepo(out, identity);
    }

    // Visibility. An existing pick carries its own; only a new repo asks.
    if (out.github.repoPrivate === undefined) {
      out.github.repoPrivate = await ask(
        p.select({
          message: 'Repository visibility',
          initialValue: false,
          options: [
            { value: false, label: 'Public', hint: 'the infra contains no secrets' },
            { value: true, label: 'Private' },
          ],
        }),
      );
    }

    try {
      const ctx = await createContext({
        token: out.github.token!,
        repoName: out.github.repoName!,
        repoPrivate: out.github.repoPrivate ?? false,
      });
      const { state } = await inspectRepo(ctx);
      if (!(state === 'non-empty' && alreadyPushed)) {
        assertRepoUsable(ctx, state);
      }
      const repo = `${ctx.owner}/${out.github.repoName}`;
      p.outro(
        state === 'not-found'
          ? `GitHub connected — ${repo} will be created after confirmation.`
          : state === 'non-empty'
            ? `GitHub connected — resuming, ${repo} was already pushed.`
            : `GitHub connected — existing empty repository ${repo} will be reused.`,
      );
      return;
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      log.error(error.message);
      if (error.field === 'repo') {
        // Bad repo choice: re-run the selector and re-derive its visibility.
        out.github.repoName = undefined;
        out.github.repoPrivate = undefined;
      } else {
        out.github.token = undefined;
      }
    }
  }
}

/** Infisical block: host + machine identity, then verify login and project. */
async function askInfisical(out: PartialAnswers): Promise<void> {
  p.intro('Infisical — secret-manager project and machine identity');
  if (!out.infisical.host) {
    const choice = await ask(
      p.select({
        message: 'Infisical host',
        initialValue: 'us',
        options: [
          { value: 'us', label: 'US — app.infisical.com', hint: 'default' },
          { value: 'eu', label: 'EU — eu.infisical.com' },
          { value: 'other', label: 'Other (self-hosted)' },
        ],
      }),
    );
    if (choice === 'us') out.infisical.host = DEFAULT_INFISICAL_HOST;
    else if (choice === 'eu') out.infisical.host = 'https://eu.infisical.com';
    else {
      out.infisical.host = await ask(
        p.text({
          message: 'Infisical host URL',
          placeholder: 'https://infisical.example.com',
          validate: validate((v) => validateUrl(v, 'Infisical host')),
        }),
      );
    }
  }

  for (;;) {
    if (!out.infisical.clientId) {
      out.infisical.clientId = await text('Infisical machine identity client ID');
    }
    if (!out.infisical.clientSecret) {
      out.infisical.clientSecret = await secret('Infisical machine identity client secret');
    }
    if (!out.infisical.projectId && !out.infisical.projectName) {
      const id = await ask(
        p.text({
          message: `Infisical project ID to reuse (leave empty to create "${out.projectName}")`,
          placeholder: 'empty: create a new project',
          defaultValue: '',
        }),
      );
      if (id.trim()) out.infisical.projectId = id.trim();
      else out.infisical.projectName = out.projectName;
    }

    try {
      const { projectName } = await validateInfisical({
        host: out.infisical.host!,
        clientId: out.infisical.clientId!,
        clientSecret: out.infisical.clientSecret!,
        projectId: out.infisical.projectId,
      });
      if (projectName) out.infisical.projectName = projectName;
      p.outro(
        out.infisical.projectId
          ? `Infisical connected — existing project "${projectName}" (${out.infisical.projectId}) will be reused.`
          : `Infisical connected — project "${out.infisical.projectName}" will be created after confirmation.`,
      );
      return;
    } catch (error) {
      if (!(error instanceof InfisicalError)) throw error;
      log.error(error.message);
      if (error.field === 'project') {
        out.infisical.projectId = undefined;
        out.infisical.projectName = undefined;
      } else {
        out.infisical.clientId = undefined;
        out.infisical.clientSecret = undefined;
      }
    }
  }
}

async function askRegion(out: PartialAnswers): Promise<void> {
  if (out.region) return;
  out.region = await ask(
    p.select({
      message: 'Scaleway region',
      initialValue: DEFAULT_REGION as string,
      options: REGIONS.map((r) => ({ value: r as string, label: r })),
    }),
  );
}

/** Scaleway block: keys + IDs, then verify with a read-only API call. */
async function askScaleway(out: PartialAnswers): Promise<void> {
  p.intro('Scaleway — account keys and project');
  for (;;) {
    if (!out.scaleway.accessKey) out.scaleway.accessKey = await text('Scaleway access key');
    if (!out.scaleway.secretKey) out.scaleway.secretKey = await secret('Scaleway secret key');
    if (!out.scaleway.projectId) out.scaleway.projectId = await text('Scaleway project ID');
    if (!out.scaleway.organizationId) {
      out.scaleway.organizationId = await text('Scaleway organization ID');
    }

    try {
      await validateScalewayCredentials({
        secretKey: out.scaleway.secretKey!,
        projectId: out.scaleway.projectId!,
        organizationId: out.scaleway.organizationId!,
      });
      p.outro('Scaleway connected — credentials valid and project reachable.');
      return;
    } catch (error) {
      if (!(error instanceof ScalewayError)) throw error;
      log.error(error.message);
      switch (error.code) {
        case 'auth':
          out.scaleway.accessKey = undefined;
          out.scaleway.secretKey = undefined;
          break;
        case 'project':
          out.scaleway.projectId = undefined;
          break;
        case 'organization':
          out.scaleway.organizationId = undefined;
          break;
        default: {
          // Transient API error: nothing to correct, offer a plain retry.
          const retry = await ask(p.confirm({ message: 'Scaleway API error. Retry?' }));
          if (!retry) bail();
        }
      }
    }
  }
}

export async function confirmSummary(summary: string): Promise<boolean> {
  p.note(summary, 'About to create');
  return ask(p.confirm({ message: 'Proceed? No account is touched before this point.' }));
}
