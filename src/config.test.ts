import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  finalizeAnswers,
  fromEnv,
  mergeAnswers,
  missingRequired,
  normalizeEnvSlugs,
  parseEnvironments,
  stateBucketName,
  validateProjectName,
  validateRegion,
  validateScale,
} from './config.js';

const fullPartial = {
  projectName: 'my-app',
  region: 'fr-par',
  scaleway: {
    accessKey: 'SCWXXXXXXXXXXXXXXXXX',
    secretKey: 'secret',
    projectId: 'proj-id',
    organizationId: 'org-id',
  },
  infisical: { clientId: 'cid', clientSecret: 'csecret' },
  github: { token: 'ghp_token' },
  scaling: {},
};

describe('validateProjectName', () => {
  it('accepts dns-safe names', () => {
    expect(validateProjectName('my-app')).toBe('my-app');
    expect(validateProjectName('a')).toBe('a');
    expect(validateProjectName('app2')).toBe('app2');
  });

  it('rejects invalid names', () => {
    for (const bad of ['My-App', '-app', 'app-', '2app', 'a'.repeat(51), 'a--b', 'app_name', '']) {
      expect(() => validateProjectName(bad), bad).toThrow(ConfigError);
    }
  });
});

describe('validateRegion', () => {
  it('accepts supported regions', () => {
    expect(validateRegion('fr-par')).toBe('fr-par');
    expect(validateRegion(' nl-ams ')).toBe('nl-ams');
  });

  it('rejects unknown regions', () => {
    expect(() => validateRegion('us-east-1')).toThrow(ConfigError);
  });
});

describe('validateScale', () => {
  it('rejects min scale above max scale', () => {
    expect(() =>
      finalizeAnswers({ ...fullPartial, scaling: { prod: { minScale: 5, maxScale: 1 } } }),
    ).toThrow(ConfigError);
    // Equal min and max is valid (fixed-size deployment).
    expect(() =>
      finalizeAnswers({ ...fullPartial, scaling: { prod: { minScale: 2, maxScale: 2 } } }),
    ).not.toThrow();
  });

  it('accepts integers in range', () => {
    expect(validateScale(0, 'x')).toBe(0);
    expect(validateScale('5', 'x')).toBe(5);
  });

  it('rejects out-of-range or non-integer values', () => {
    for (const bad of [-1, 21, 1.5, 'abc']) {
      expect(() => validateScale(bad, 'x')).toThrow(ConfigError);
    }
  });
});

describe('mergeAnswers', () => {
  it('later sources win', () => {
    const merged = mergeAnswers(
      {
        projectName: 'from-env',
        scaleway: { accessKey: 'env' },
        infisical: {},
        github: {},
        scaling: {},
      },
      { projectName: 'from-flag', scaleway: {}, infisical: {}, github: {}, scaling: {} },
    );
    expect(merged.projectName).toBe('from-flag');
    expect(merged.scaleway.accessKey).toBe('env');
  });

  it('undefined values never overwrite', () => {
    const merged = mergeAnswers(
      { projectName: 'keep', scaleway: {}, infisical: {}, github: {}, scaling: {} },
      { projectName: undefined, scaleway: {}, infisical: {}, github: {}, scaling: {} },
    );
    expect(merged.projectName).toBe('keep');
  });
});

describe('fromEnv', () => {
  it('reads Scaleway, Infisical and GitHub variables', () => {
    const partial = fromEnv({
      SCW_ACCESS_KEY: 'ak',
      SCW_SECRET_KEY: 'sk',
      SCW_DEFAULT_PROJECT_ID: 'pid',
      SCW_DEFAULT_ORGANIZATION_ID: 'oid',
      INFISICAL_CLIENT_ID: 'cid',
      INFISICAL_PROJECT_ID: 'wid',
      GH_TOKEN: 'tok',
    });
    expect(partial.scaleway).toMatchObject({ accessKey: 'ak', secretKey: 'sk', projectId: 'pid' });
    expect(partial.infisical.clientId).toBe('cid');
    expect(partial.infisical.projectId).toBe('wid');
    expect(partial.github.token).toBe('tok');
  });
});

describe('finalizeAnswers', () => {
  it('produces defaults and derived values', () => {
    const answers = finalizeAnswers(structuredClone(fullPartial));
    expect(answers.stateBucket).toBe('my-app-tfstate');
    expect(answers.targetDir).toBe('my-app');
    expect(answers.github.repoName).toBe('my-app');
    expect(answers.github.repoPrivate).toBe(false);
    expect(answers.infisical.host).toBe('https://app.infisical.com');
    expect(answers.basicAuth).toBe(true);
    expect(answers.objectStorage).toBe(false);
  });

  it('defaults to the staging+prod preset with sensible per-env rules', () => {
    const answers = finalizeAnswers(structuredClone(fullPartial));
    expect(answers.environments.map((e) => e.slug)).toEqual(['staging', 'prod']);
    const staging = answers.environments.find((e) => e.slug === 'staging')!;
    const prod = answers.environments.find((e) => e.slug === 'prod')!;
    // Production is gated and never basic-auth'd; non-prod is auto-deploy + basic auth.
    expect(prod.gated).toBe(true);
    expect(prod.basicAuth).toBe(false);
    expect(prod.githubEnvironment).toBe('production');
    expect(prod.maxScale).toBe(1);
    expect(staging.gated).toBe(false);
    expect(staging.basicAuth).toBe(true);
    expect(staging.githubEnvironment).toBe('staging');
    expect(staging.maxScale).toBe(1);
  });

  it('honours a chosen environment set, object storage and scaling overrides', () => {
    const partial = structuredClone(fullPartial);
    partial.environments = ['prod'];
    partial.objectStorage = true;
    partial.scaling = { prod: { minScale: 1, maxScale: 5 } };
    const answers = finalizeAnswers(partial);
    expect(answers.environments.map((e) => e.slug)).toEqual(['prod']);
    expect(answers.objectStorage).toBe(true);
    expect(answers.environments[0].minScale).toBe(1);
    expect(answers.environments[0].maxScale).toBe(5);
  });

  it('disables non-prod basic auth when basicAuth is false', () => {
    const partial = structuredClone(fullPartial);
    partial.basicAuth = false;
    const staging = finalizeAnswers(partial).environments.find((e) => e.slug === 'staging')!;
    expect(staging.basicAuth).toBe(false);
  });

  it('keeps an Infisical project ID only when one is provided', () => {
    expect(finalizeAnswers(structuredClone(fullPartial)).infisical.projectId).toBeUndefined();
    const partial = structuredClone(fullPartial);
    (partial.infisical as { projectId?: string }).projectId = '  wid  ';
    expect(finalizeAnswers(partial).infisical.projectId).toBe('wid');
  });

  it('throws with a clear message when a credential is missing', () => {
    const partial = structuredClone(fullPartial);
    partial.scaleway.secretKey = '';
    expect(() => finalizeAnswers(partial)).toThrow(/Scaleway secret key/);
  });
});

describe('parseEnvironments / normalizeEnvSlugs', () => {
  it('resolves presets and free lists into deploy order', () => {
    expect(parseEnvironments('staging+prod')).toEqual(['staging', 'prod']);
    expect(parseEnvironments('prod')).toEqual(['prod']);
    expect(parseEnvironments('prod,dev,staging')).toEqual(['dev', 'staging', 'prod']);
    expect(normalizeEnvSlugs(['prod', 'prod'])).toEqual(['prod']);
  });

  it('rejects unknown environments', () => {
    expect(() => parseEnvironments('qa')).toThrow(ConfigError);
    expect(() => normalizeEnvSlugs([])).toThrow(ConfigError);
  });
});

describe('missingRequired', () => {
  it('lists every missing credential', () => {
    const missing = missingRequired({ scaleway: {}, infisical: {}, github: {}, scaling: {} });
    expect(missing.length).toBe(8);
    expect(missing.join('\n')).toMatch(/GitHub token/);
  });

  it('is empty when everything is provided', () => {
    expect(missingRequired(structuredClone(fullPartial))).toEqual([]);
  });
});

describe('stateBucketName', () => {
  it('derives the bucket from the project name', () => {
    expect(stateBucketName('demo')).toBe('demo-tfstate');
  });
});
