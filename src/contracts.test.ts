import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { finalizeAnswers } from './config.js';
import {
  BASE_SYNCED_KEYS,
  BASIC_AUTH_FLAG,
  BASIC_AUTH_SECRET_KEYS,
  CI_SECRET_NAMES,
  CI_VARIABLE_NAMES,
  CONTRACT_VERSION,
  ENV_RESOURCE_SUFFIXES,
  INFISICAL_SECRETS_OUTPUT,
  INFISICAL_SECRETS_OUTPUT_PATTERN,
  PLACEHOLDER_SOURCE_IMAGE,
  placeholderImageRef,
  planStatusCheckContext,
  resourceName,
  S3_SECRET_KEYS,
} from './contracts.js';
import { generateProject, MANIFEST_FILE } from './generate.js';

// The CLI configures the user's account by name (branch protection contexts,
// Actions secrets/variables, seeded Infisical keys) and the generated repo
// references the same names. These tests render the templates once and assert
// both sides agree, so a rename on either side fails here instead of at
// runtime in the user's account.

let dir: string;
let target: string;
const read = (rel: string) => readFileSync(join(target, rel), 'utf8');

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'keel-contracts-'));
  target = join(dir, 'demo-app');
  generateProject(
    finalizeAnswers({
      projectName: 'demo-app',
      region: 'fr-par',
      targetDir: target,
      scaleway: { accessKey: 'ak', secretKey: 'sk', projectId: 'pid', organizationId: 'oid' },
      infisical: { clientId: 'cid', clientSecret: 'cs' },
      github: { token: 'tok' },
      objectStorage: true,
      scaling: {},
    }),
    { git: false },
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('contracts between the bootstrap and the generated repository', () => {
  it('branch protection requires exactly the plan job names', () => {
    // protectMainBranch requires planStatusCheckContext(slug) per environment;
    // the plan workflow must name its jobs with the same format.
    const plan = read('.github/workflows/terraform-plan.yml');
    expect(plan).toContain(`name: ${planStatusCheckContext('${{ matrix.environment }}')}`);
  });

  it('sync-secrets.sh collects the outputs the root module exposes, by prefix', () => {
    expect(read('outputs.tf')).toContain(`output "${INFISICAL_SECRETS_OUTPUT}"`);
    // The script must use the exact pattern from contracts.ts, so the base
    // output and any module-contributed infisical_secrets_<name> are synced.
    expect(read('.github/scripts/sync-secrets.sh')).toContain(INFISICAL_SECRETS_OUTPUT_PATTERN);
  });

  it('the keys seeded by the CLI are the ones the outputs produce', () => {
    const outputs = read('outputs.tf');
    for (const key of [...BASE_SYNCED_KEYS, ...S3_SECRET_KEYS]) {
      expect(outputs, key).toContain(key);
    }
  });

  it('Basic Auth names seeded by the CLI match what the stack injects and the docs promise', () => {
    // The CLI seeds USER/PASSWORD, app_stack injects the flag, the generated
    // README tells the app which variables to enforce: one shared language.
    expect(read('modules/app_stack/main.tf')).toContain(`${BASIC_AUTH_FLAG} = "true"`);
    const readme = read('README.md');
    for (const key of BASIC_AUTH_SECRET_KEYS) {
      expect(readme, key).toContain(key);
    }
  });

  it('per-environment resource naming matches the CLI convention', () => {
    // local.name in app_stack must build names exactly like resourceName(),
    // which the CLI uses for registry hints.
    expect(read('modules/app_stack/main.tf')).toContain(
      `name = "${resourceName('${var.project_name}', '${var.environment}')}"`,
    );
  });

  it('teardown deletes by the exact names the app_stack creates', () => {
    // keel teardown finds resources by name; a rename in the template without
    // ENV_RESOURCE_SUFFIXES would silently leave orphans behind. Whitespace
    // is fmt's business, not the contract's, so match names, not alignment.
    const stack = read('modules/app_stack/main.tf');
    for (const suffix of Object.values(ENV_RESOURCE_SUFFIXES)) {
      expect(stack, suffix).toMatch(new RegExp(`name\\s+= "\\$\\{local\\.name\\}${suffix}"`));
    }
  });

  it('the committed manifest records the contract version', () => {
    const manifest = JSON.parse(read(MANIFEST_FILE)) as {
      contractVersion: number;
      projectName: string;
    };
    expect(manifest.contractVersion).toBe(CONTRACT_VERSION);
    expect(manifest.projectName).toBe('demo-app');
  });

  it('every Actions secret and variable set by the CLI is read by a workflow', () => {
    const workflows = [
      read('.github/workflows/terraform-plan.yml'),
      read('.github/workflows/terraform-apply.yml'),
      read('.github/workflows/terraform-drift.yml'),
    ].join('\n');
    for (const name of CI_SECRET_NAMES) {
      expect(workflows, name).toContain(`secrets.${name}`);
    }
    for (const name of CI_VARIABLE_NAMES) {
      expect(workflows, name).toContain(`vars.${name}`);
    }
  });

  it('plan and drift discover their matrix from the tfvars files', () => {
    for (const workflow of ['terraform-plan.yml', 'terraform-drift.yml']) {
      const content = read(`.github/workflows/${workflow}`);
      expect(content, workflow).toContain('*.tfvars');
      expect(content, workflow).toContain('fromJSON(needs.discover.outputs.environments)');
    }
  });

  it('the workspace/environment guard is rendered into main.tf', () => {
    expect(read('main.tf')).toContain('terraform.workspace == var.environment');
  });

  it('the placeholder build workflow publishes exactly the image the seed step pulls', () => {
    // Every generated repo's first apply pulls PLACEHOLDER_SOURCE_IMAGE from
    // GHCR; the workflow that builds and pushes it lives in this repo. The
    // tag exists in both places — one test keeps them the same, so a bump on
    // one side cannot ship a CLI that seeds an image nobody publishes.
    const workflow = readFileSync(
      fileURLToPath(new URL('../.github/workflows/placeholder.yml', import.meta.url)),
      'utf8',
    );
    expect(workflow).toContain(PLACEHOLDER_SOURCE_IMAGE);
  });

  it('the tfvars placeholder image is exactly what the seed step looks for', () => {
    // The seed step no-ops by comparing container_image against the ref it
    // would seed: if the two renderings ever diverge, every apply re-runs the
    // seeding (or worse, never seeds) — pin them to the same contract.
    const apply = read('.github/workflows/terraform-apply.yml');
    for (const env of ['staging', 'prod']) {
      const ref = placeholderImageRef('demo-app', 'fr-par', env);
      expect(read(`${env}.tfvars`)).toContain(`container_image = "${ref}"`);
      expect(apply, env).toContain(`"$image" != "${ref}"`);
    }
    // The one-time source the seed step copies from.
    expect(apply).toContain(`docker pull ${PLACEHOLDER_SOURCE_IMAGE}`);
    // The -target that pre-creates the registry namespace must address the
    // module instance main.tf actually declares.
    expect(read('main.tf')).toContain('module "app_stack"');
    expect(apply).toContain('-target=module.app_stack.scaleway_registry_namespace.this');
    expect(read('modules/app_stack/main.tf')).toContain(
      'resource "scaleway_registry_namespace" "this"',
    );
  });
});
