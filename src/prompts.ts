import * as p from '@clack/prompts';

import {
  ConfigError,
  DEFAULT_ENV_PRESET,
  DEFAULT_INFISICAL_HOST,
  DEFAULT_REGION,
  ENV_PRESETS,
  envDefaultScale,
  type EnvSlug,
  REGIONS,
  type PartialAnswers,
  validateProjectName,
  validateScale,
} from './config.js';

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

/** Interactively fill everything still missing from flags/env/config file. */
export async function fillMissing(
  partial: PartialAnswers,
  options: { advanced: boolean },
): Promise<PartialAnswers> {
  const out = structuredClone(partial);

  if (!out.projectName) {
    out.projectName = await ask(
      p.text({
        message: 'Project name (dns-safe, used for repo, bucket and resources)',
        placeholder: 'my-app',
        validate: validate(validateProjectName),
      }),
    );
  }

  if (!out.region) {
    out.region = await ask(
      p.select({
        message: 'Scaleway region',
        initialValue: DEFAULT_REGION as string,
        options: REGIONS.map((r) => ({ value: r as string, label: r })),
      }),
    );
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

  if (!out.scaleway.accessKey) out.scaleway.accessKey = await text('Scaleway access key');
  if (!out.scaleway.secretKey) out.scaleway.secretKey = await secret('Scaleway secret key');
  if (!out.scaleway.projectId) out.scaleway.projectId = await text('Scaleway project ID');
  if (!out.scaleway.organizationId)
    out.scaleway.organizationId = await text('Scaleway organization ID');

  if (!out.infisical.host) {
    out.infisical.host = await ask(
      p.text({ message: 'Infisical host', initialValue: DEFAULT_INFISICAL_HOST }),
    );
  }
  if (!out.infisical.clientId)
    out.infisical.clientId = await text('Infisical machine identity client ID');
  if (!out.infisical.clientSecret)
    out.infisical.clientSecret = await secret('Infisical machine identity client secret');
  if (!out.infisical.projectName) {
    out.infisical.projectName = await ask(
      p.text({
        message: 'Infisical project name (existing project is reused, otherwise created)',
        initialValue: out.projectName,
      }),
    );
  }

  if (!out.github.token) out.github.token = await secret('GitHub token (scopes: repo, workflow)');
  if (!out.github.repoName) {
    out.github.repoName = await ask(
      p.text({
        message: 'GitHub repository name',
        initialValue: out.projectName,
        validate: validate(validateProjectName),
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

  if (!out.environments || out.environments.length === 0) {
    const preset = await ask(
      p.select({
        message: 'Which environments do you want?',
        initialValue: DEFAULT_ENV_PRESET,
        options: [
          { value: 'prod', label: 'Production only', hint: 'single environment' },
          {
            value: 'staging+prod',
            label: 'Staging + Production',
            hint: 'recommended',
          },
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

  return out;
}

export async function confirmSummary(summary: string): Promise<boolean> {
  p.note(summary, 'About to create');
  return ask(p.confirm({ message: 'Proceed? No account is touched before this point.' }));
}
