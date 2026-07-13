export const REGIONS = ['fr-par', 'nl-ams', 'pl-waw'] as const;
export type Region = (typeof REGIONS)[number];

export const DEFAULT_INFISICAL_HOST = 'https://app.infisical.com';
export const DEFAULT_REGION: Region = 'fr-par';

export interface ScalingConfig {
  stagingMinScale: number;
  stagingMaxScale: number;
  prodMinScale: number;
  prodMaxScale: number;
}

export const DEFAULT_SCALING: ScalingConfig = {
  stagingMinScale: 0,
  stagingMaxScale: 1,
  prodMinScale: 0,
  prodMaxScale: 2,
};

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
  basicAuthStaging: boolean;
  scaling: ScalingConfig;
}

/** Partial answers collected from flags, config file and environment. */
export type PartialAnswers = {
  projectName?: string;
  region?: string;
  targetDir?: string;
  scaleway: Partial<Answers['scaleway']>;
  infisical: Partial<Answers['infisical']>;
  github: Partial<Answers['github']>;
  basicAuthStaging?: boolean;
  scaling: Partial<ScalingConfig>;
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
    for (const key of ['projectName', 'region', 'targetDir', 'basicAuthStaging'] as const) {
      const value = src[key];
      if (value !== undefined) {
        (out as Record<string, unknown>)[key] = value;
      }
    }
    for (const group of ['scaleway', 'infisical', 'github', 'scaling'] as const) {
      for (const [k, v] of Object.entries(src[group] ?? {})) {
        if (v !== undefined) {
          (out[group] as Record<string, unknown>)[k] = v;
        }
      }
    }
  }
  return out;
}

/** Validate a fully-collected set of answers and freeze it into a Config. */
export function finalizeAnswers(partial: PartialAnswers): Answers {
  const projectName = validateProjectName(requireString(partial.projectName, 'project name'));
  const region = validateRegion(partial.region ?? DEFAULT_REGION);
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
    basicAuthStaging: partial.basicAuthStaging ?? true,
    scaling: {
      stagingMinScale: validateScale(
        partial.scaling.stagingMinScale ?? DEFAULT_SCALING.stagingMinScale,
        'staging min scale',
      ),
      stagingMaxScale: validateScale(
        partial.scaling.stagingMaxScale ?? DEFAULT_SCALING.stagingMaxScale,
        'staging max scale',
      ),
      prodMinScale: validateScale(
        partial.scaling.prodMinScale ?? DEFAULT_SCALING.prodMinScale,
        'prod min scale',
      ),
      prodMaxScale: validateScale(
        partial.scaling.prodMaxScale ?? DEFAULT_SCALING.prodMaxScale,
        'prod max scale',
      ),
    },
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
