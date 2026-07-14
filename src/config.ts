export const REGIONS = ['fr-par', 'nl-ams', 'pl-waw'] as const;
export type Region = (typeof REGIONS)[number];

export const DEFAULT_INFISICAL_HOST = 'https://app.infisical.com';
export const DEFAULT_REGION: Region = 'fr-par';

/**
 * The environments keel knows how to provision. The order here is also the
 * deploy order (dev first, prod last) and drives the apply-workflow chain.
 */
export const KNOWN_ENV_SLUGS = ['dev', 'staging', 'prod'] as const;
export type EnvSlug = (typeof KNOWN_ENV_SLUGS)[number];

interface EnvDefault {
  displayName: string;
  /** GitHub deployment environment name (production keeps its full name). */
  githubEnvironment: string;
  production: boolean;
  /** Whether the GitHub environment requires a manual approval before apply. */
  gated: boolean;
  minScale: number;
  maxScale: number;
}

const ENV_DEFAULTS: Record<EnvSlug, EnvDefault> = {
  dev: {
    displayName: 'Development',
    githubEnvironment: 'dev',
    production: false,
    gated: false,
    minScale: 0,
    maxScale: 1,
  },
  staging: {
    displayName: 'Staging',
    githubEnvironment: 'staging',
    production: false,
    gated: false,
    minScale: 0,
    maxScale: 1,
  },
  prod: {
    displayName: 'Production',
    githubEnvironment: 'production',
    production: true,
    gated: true,
    minScale: 0,
    maxScale: 2,
  },
};

/** Default min/max scale for an environment, for prompts and summaries. */
export function envDefaultScale(slug: EnvSlug): { minScale: number; maxScale: number } {
  const def = ENV_DEFAULTS[slug];
  return { minScale: def.minScale, maxScale: def.maxScale };
}

/** Named presets exposed on the CLI; the value is the list of env slugs. */
export const ENV_PRESETS: Record<string, EnvSlug[]> = {
  prod: ['prod'],
  'staging+prod': ['staging', 'prod'],
  'dev+staging+prod': ['dev', 'staging', 'prod'],
};
export const DEFAULT_ENV_PRESET = 'staging+prod';

/** A fully-resolved environment, ready to render into templates and APIs. */
export interface EnvConfig {
  slug: EnvSlug;
  displayName: string;
  githubEnvironment: string;
  production: boolean;
  gated: boolean;
  basicAuth: boolean;
  minScale: number;
  maxScale: number;
}

/** Per-environment scaling overrides, keyed by env slug. */
export type ScalingOverrides = Partial<Record<string, { minScale?: number; maxScale?: number }>>;

/** Everything the tool needs to generate and bootstrap a project. */
export interface Answers {
  projectName: string;
  region: Region;
  targetDir: string;
  stateBucket: string;
  scaleway: {
    accessKey: string;
    secretKey: string;
    projectId: string;
    organizationId: string;
  };
  infisical: {
    host: string;
    clientId: string;
    clientSecret: string;
    projectName: string;
  };
  github: {
    token: string;
    repoName: string;
    repoPrivate: boolean;
  };
  /** Protect non-production environments with Basic Auth (enforced by the app). */
  basicAuth: boolean;
  /** Provision a per-environment Object Storage bucket for the application. */
  objectStorage: boolean;
  environments: EnvConfig[];
}

/** Partial answers collected from flags, config file and environment. */
export type PartialAnswers = {
  projectName?: string;
  region?: string;
  targetDir?: string;
  scaleway: Partial<Answers['scaleway']>;
  infisical: Partial<Answers['infisical']>;
  github: Partial<Answers['github']>;
  basicAuth?: boolean;
  objectStorage?: boolean;
  /** Selected environment slugs; undefined means "use the default preset". */
  environments?: string[];
  scaling: ScalingOverrides;
};

export class ConfigError extends Error {}

const PROJECT_NAME_RE = /^[a-z](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export function validateProjectName(name: string): string {
  const trimmed = name.trim();
  if (!PROJECT_NAME_RE.test(trimmed) || trimmed.includes('--')) {
    throw new ConfigError(
      `Invalid project name "${trimmed}": use 1-50 lowercase letters, digits or single hyphens, ` +
        'starting with a letter and not ending with a hyphen (DNS-safe).',
    );
  }
  return trimmed;
}

export function validateRegion(region: string): Region {
  const trimmed = region.trim() as Region;
  if (!REGIONS.includes(trimmed)) {
    throw new ConfigError(`Invalid region "${region}". Supported regions: ${REGIONS.join(', ')}.`);
  }
  return trimmed;
}

export function validateScale(value: unknown, label: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 20) {
    throw new ConfigError(`Invalid ${label}: expected an integer between 0 and 20.`);
  }
  return n;
}

/**
 * Parse a `--environments` value into an ordered, de-duplicated slug list.
 * Accepts preset names ("staging+prod") or free lists ("dev,staging,prod").
 */
export function parseEnvironments(raw: string): EnvSlug[] {
  const trimmed = raw.trim();
  if (ENV_PRESETS[trimmed]) return ENV_PRESETS[trimmed];
  const slugs = trimmed
    .split(/[\s,+]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return normalizeEnvSlugs(slugs);
}

/** Validate slugs against the known set and return them in deploy order. */
export function normalizeEnvSlugs(slugs: string[]): EnvSlug[] {
  for (const slug of slugs) {
    if (!(KNOWN_ENV_SLUGS as readonly string[]).includes(slug)) {
      throw new ConfigError(
        `Unknown environment "${slug}". Supported environments: ${KNOWN_ENV_SLUGS.join(', ')} ` +
          `(or a preset: ${Object.keys(ENV_PRESETS).join(', ')}).`,
      );
    }
  }
  const chosen = new Set(slugs);
  const ordered = KNOWN_ENV_SLUGS.filter((s) => chosen.has(s));
  if (ordered.length === 0) {
    throw new ConfigError('At least one environment is required.');
  }
  return ordered;
}

export function validateUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ConfigError(`Invalid ${label}: "${value}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigError(`Invalid ${label}: only http(s) URLs are supported.`);
  }
  return parsed.origin;
}

function requireString(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new ConfigError(`Missing required value: ${label}.`);
  }
  return trimmed;
}

export function stateBucketName(projectName: string): string {
  return `${projectName}-tfstate`;
}

/** Read partial answers from environment variables. */
export function fromEnv(env: NodeJS.ProcessEnv): PartialAnswers {
  return {
    scaleway: {
      accessKey: env.SCW_ACCESS_KEY,
      secretKey: env.SCW_SECRET_KEY,
      projectId: env.SCW_DEFAULT_PROJECT_ID ?? env.SCW_PROJECT_ID,
      organizationId: env.SCW_DEFAULT_ORGANIZATION_ID ?? env.SCW_ORGANIZATION_ID,
    },
    infisical: {
      host: env.INFISICAL_HOST,
      clientId: env.INFISICAL_CLIENT_ID,
      clientSecret: env.INFISICAL_CLIENT_SECRET,
    },
    github: {
      token: env.GITHUB_TOKEN ?? env.GH_TOKEN,
    },
    scaling: {},
  };
}

/** Merge partial answers; later sources win over earlier ones. */
export function mergeAnswers(...sources: PartialAnswers[]): PartialAnswers {
  const out: PartialAnswers = { scaleway: {}, infisical: {}, github: {}, scaling: {} };
  for (const src of sources) {
    for (const key of [
      'projectName',
      'region',
      'targetDir',
      'basicAuth',
      'objectStorage',
    ] as const) {
      const value = src[key];
      if (value !== undefined) {
        (out as Record<string, unknown>)[key] = value;
      }
    }
    if (src.environments !== undefined) {
      out.environments = src.environments;
    }
    for (const group of ['scaleway', 'infisical', 'github'] as const) {
      for (const [k, v] of Object.entries(src[group] ?? {})) {
        if (v !== undefined) {
          (out[group] as Record<string, unknown>)[k] = v;
        }
      }
    }
    // Scaling is a per-slug record: merge each slug's fields, deepest wins.
    for (const [slug, override] of Object.entries(src.scaling ?? {})) {
      if (!override) continue;
      const current = out.scaling[slug] ?? {};
      if (override.minScale !== undefined) current.minScale = override.minScale;
      if (override.maxScale !== undefined) current.maxScale = override.maxScale;
      out.scaling[slug] = current;
    }
  }
  return out;
}

/** Build the resolved environment list from selected slugs + overrides. */
export function resolveEnvironments(
  slugs: EnvSlug[],
  basicAuth: boolean,
  overrides: ScalingOverrides,
): EnvConfig[] {
  return slugs.map((slug) => {
    const def = ENV_DEFAULTS[slug];
    const ov = overrides[slug] ?? {};
    return {
      slug,
      displayName: def.displayName,
      githubEnvironment: def.githubEnvironment,
      production: def.production,
      gated: def.gated,
      // Basic Auth is a non-production safety net; production is never gated by it.
      basicAuth: def.production ? false : basicAuth,
      minScale: validateScale(ov.minScale ?? def.minScale, `${slug} min scale`),
      maxScale: validateScale(ov.maxScale ?? def.maxScale, `${slug} max scale`),
    };
  });
}

/** Validate a fully-collected set of answers and freeze it into a Config. */
export function finalizeAnswers(partial: PartialAnswers): Answers {
  const projectName = validateProjectName(requireString(partial.projectName, 'project name'));
  const region = validateRegion(partial.region ?? DEFAULT_REGION);
  const slugs =
    partial.environments && partial.environments.length > 0
      ? normalizeEnvSlugs(partial.environments)
      : ENV_PRESETS[DEFAULT_ENV_PRESET]!;
  const basicAuth = partial.basicAuth ?? true;
  return {
    projectName,
    region,
    targetDir: partial.targetDir?.trim() || projectName,
    stateBucket: stateBucketName(projectName),
    scaleway: {
      accessKey: requireString(partial.scaleway.accessKey, 'Scaleway access key'),
      secretKey: requireString(partial.scaleway.secretKey, 'Scaleway secret key'),
      projectId: requireString(partial.scaleway.projectId, 'Scaleway project ID'),
      organizationId: requireString(partial.scaleway.organizationId, 'Scaleway organization ID'),
    },
    infisical: {
      host: validateUrl(partial.infisical.host ?? DEFAULT_INFISICAL_HOST, 'Infisical host'),
      clientId: requireString(partial.infisical.clientId, 'Infisical client ID'),
      clientSecret: requireString(partial.infisical.clientSecret, 'Infisical client secret'),
      projectName: partial.infisical.projectName?.trim() || projectName,
    },
    github: {
      token: requireString(partial.github.token, 'GitHub token'),
      repoName: validateProjectName(partial.github.repoName?.trim() || projectName),
      repoPrivate: partial.github.repoPrivate ?? false,
    },
    basicAuth,
    objectStorage: partial.objectStorage ?? false,
    environments: resolveEnvironments(slugs, basicAuth, partial.scaling),
  };
}

/** List which required values are still missing, for non-interactive runs. */
export function missingRequired(partial: PartialAnswers): string[] {
  const missing: string[] = [];
  if (!partial.projectName?.trim()) missing.push('project name (--name)');
  if (!partial.scaleway.accessKey?.trim())
    missing.push('Scaleway access key (--scw-access-key or SCW_ACCESS_KEY)');
  if (!partial.scaleway.secretKey?.trim())
    missing.push('Scaleway secret key (--scw-secret-key or SCW_SECRET_KEY)');
  if (!partial.scaleway.projectId?.trim())
    missing.push('Scaleway project ID (--scw-project-id or SCW_DEFAULT_PROJECT_ID)');
  if (!partial.scaleway.organizationId?.trim())
    missing.push('Scaleway organization ID (--scw-organization-id or SCW_DEFAULT_ORGANIZATION_ID)');
  if (!partial.infisical.clientId?.trim())
    missing.push('Infisical client ID (--infisical-client-id or INFISICAL_CLIENT_ID)');
  if (!partial.infisical.clientSecret?.trim())
    missing.push('Infisical client secret (--infisical-client-secret or INFISICAL_CLIENT_SECRET)');
  if (!partial.github.token?.trim()) missing.push('GitHub token (--github-token or GITHUB_TOKEN)');
  return missing;
}
