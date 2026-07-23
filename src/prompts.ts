import * as p from '@clack/prompts';

import {
  authenticate,
  createContext,
  detectOrigin,
  getOriginUrl,
  GitHubError,
  inspectRepo,
  assertRepoUsable,
} from './bootstrap/github.js';
import { InfisicalError, validateInfisical } from './bootstrap/infisical.js';
import { ScalewayError, validateScalewayCredentials } from './bootstrap/scaleway.js';
import {
  ConfigError,
  CONTAINER_SIZES,
  DEFAULT_CONTAINER_SIZE,
  DEFAULT_ENV_PRESET,
  DEFAULT_INFISICAL_HOST,
  DEFAULT_REGION,
  ENV_PRESETS,
  envDefaultScale,
  hydrateConfigFromManifest,
  infraRepoName,
  type EnvSlug,
  REGIONS,
  type PartialAnswers,
  validateProjectName,
  validateRepoName,
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
  const resumeDir = out.targetDir?.trim() || process.cwd();
  const manifest = readManifest(resumeDir);
  const resuming = manifest !== undefined && manifest.projectName === out.projectName;
  if (manifest && resuming) {
    hydrateConfigFromManifest(out, manifest);
    log.info(
      `Resuming "${out.projectName}" — repository, region, environments and options are locked to its .keel manifest.`,
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

export async function askProjectName(out: PartialAnswers): Promise<void> {
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

  if (out.containerSize === undefined) {
    out.containerSize = await ask(
      p.select({
        message: 'Container resources per instance (idle scales to zero; per-env in <env>.tfvars)',
        initialValue: DEFAULT_CONTAINER_SIZE,
        options: Object.entries(CONTAINER_SIZES).map(([key, size]) => ({
          value: key,
          label: `${size.cpuLimit} mvCPU / ${size.memoryLimit} MB`,
          hint: size.hint,
        })),
      }),
    );
  }

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
 * GitHub block: token first, then the target repository.
 *
 * keel runs inside the current directory. When that directory already has a
 * GitHub `origin` remote, that IS the target repository — keel pushes to it and
 * creates nothing, so neither a name nor a visibility is asked. Otherwise keel
 * will create a repository for you, and asks only for its name and visibility.
 */
async function askGitHub(out: PartialAnswers): Promise<void> {
  const targetDir = out.targetDir?.trim() || process.cwd();
  // When resuming a run that already pushed, the repo legitimately has
  // commits: a non-empty repo must not block the resume.
  const alreadyPushed = isDone(loadState(targetDir, out.projectName!), 'github-push');
  const origin = detectOrigin(targetDir);
  // An origin keel cannot target (non-GitHub, or an SSH host alias) is
  // ambiguous: fail fast, before asking for anything, instead of creating a
  // repository and pushing the code to a different remote.
  if (!origin && getOriginUrl(targetDir)) {
    log.error(
      `This directory's "origin" remote is not a github.com URL keel can use. Remove it, ` +
        'or point it at the GitHub repository keel should use, then run keel again.',
    );
    bail();
  }

  p.intro('GitHub — token and repository');
  for (;;) {
    if (!out.github.token) {
      out.github.token = await secret('GitHub token (scopes: repo, workflow)');
    }
    try {
      await authenticate(out.github.token!);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      log.error(error.message);
      out.github.token = undefined;
      continue;
    }

    if (origin) {
      // The user already created the repository: keel adopts it as-is.
      out.github.repoName = origin.repo;
      if (out.github.repoPrivate === undefined) out.github.repoPrivate = false;
    } else {
      // keel will create the repository — ask its name and visibility unless
      // fixed by flags/--config/a resumed run.
      if (!out.github.repoName) {
        out.github.repoName = await ask(
          p.text({
            message: 'Repository name (keel will create it)',
            initialValue: out.projectName ? infraRepoName(out.projectName) : undefined,
            validate: validate(validateRepoName),
          }),
        );
      }
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
    }

    try {
      const ctx = await createContext(
        {
          token: out.github.token!,
          repoName: out.github.repoName!,
          repoPrivate: out.github.repoPrivate ?? false,
        },
        targetDir,
      );
      const { state } = await inspectRepo(ctx);
      if (!(state === 'non-empty' && alreadyPushed)) {
        assertRepoUsable(ctx, state);
      }
      const repo = `${ctx.owner}/${ctx.repo}`;
      p.outro(
        state === 'not-found'
          ? `GitHub connected — ${repo} will be created after confirmation.`
          : state === 'non-empty'
            ? `GitHub connected — resuming, ${repo} was already pushed.`
            : origin
              ? `GitHub connected — will push to your existing repository ${repo}.`
              : `GitHub connected — existing empty repository ${repo} will be reused.`,
      );
      return;
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      log.error(error.message);
      if (origin) {
        // The target repository is fixed by the directory's origin remote, so a
        // repo-level problem (commits already present, no push access) is not
        // something a re-prompt can fix — only a bad token is worth re-asking.
        if (error.field === 'repo') bail();
        out.github.token = undefined;
      } else if (error.field === 'repo') {
        // Bad repo choice: re-ask the name and re-derive its visibility.
        out.github.repoName = undefined;
        out.github.repoPrivate = undefined;
      } else {
        out.github.token = undefined;
      }
    }
  }
}

/** Host selector shared by the bootstrap block and the teardown credentials. */
async function askInfisicalHost(out: PartialAnswers): Promise<void> {
  if (out.infisical.host) return;
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

/** Infisical block: host + machine identity, then verify login and project. */
async function askInfisical(out: PartialAnswers): Promise<void> {
  p.intro('Infisical — secret-manager project and machine identity');
  await askInfisicalHost(out);

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
      const { warning } = await validateScalewayCredentials({
        secretKey: out.scaleway.secretKey!,
        projectId: out.scaleway.projectId!,
        organizationId: out.scaleway.organizationId!,
      });
      // e.g. an org policy that would make the first CI apply fail: better a
      // loud heads-up now, while it is a 30-second console fix, than a red
      // pipeline hours after everything here looked green.
      if (warning) log.warn(warning);
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

/**
 * Ask only what teardown still misses: Scaleway and Infisical credentials —
 * GitHub is never touched — plus the two coordinates that silently redirect
 * the deletion when wrong: region and Infisical host. Looking in fr-par for a
 * nl-ams project reports everything "absent" and looks like a clean teardown,
 * so neither is ever defaulted silently here. Unlike the bootstrap blocks
 * there is no read-only pre-validation — every delete call fails with a
 * typed, named error anyway.
 */
export async function fillTeardownCredentials(partial: PartialAnswers): Promise<PartialAnswers> {
  const out = structuredClone(partial);
  await askRegion(out);
  await askInfisicalHost(out);
  if (!out.infisical.clientId) {
    out.infisical.clientId = await text('Infisical machine identity client ID');
  }
  if (!out.infisical.clientSecret) {
    out.infisical.clientSecret = await secret('Infisical machine identity client secret');
  }
  if (!out.scaleway.accessKey) out.scaleway.accessKey = await text('Scaleway access key');
  if (!out.scaleway.secretKey) out.scaleway.secretKey = await secret('Scaleway secret key');
  if (!out.scaleway.projectId) out.scaleway.projectId = await text('Scaleway project ID');
  if (!out.scaleway.organizationId) {
    out.scaleway.organizationId = await text('Scaleway organization ID');
  }
  return out;
}

/** Destructive confirmation: the user must type the project name back. */
export async function confirmTeardown(summary: string, projectName: string): Promise<boolean> {
  p.note(summary, 'About to DELETE');
  const typed = await ask(
    p.text({ message: `Type the project name ("${projectName}") to confirm deletion` }),
  );
  return typed.trim() === projectName;
}
