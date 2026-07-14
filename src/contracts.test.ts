import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { finalizeAnswers } from './config.js';
import {
  CI_SECRET_NAMES,
  CI_VARIABLE_NAMES,
  INFISICAL_SECRETS_OUTPUT,
  planStatusCheckContext,
  S3_SECRET_KEYS,
} from './contracts.js';
import { generateProject } from './generate.js';

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

  it('sync-secrets.sh reads the Terraform output the root module exposes', () => {
    expect(read('outputs.tf')).toContain(`output "${INFISICAL_SECRETS_OUTPUT}"`);
    expect(read('.github/scripts/sync-secrets.sh')).toContain(
      `terraform output -json ${INFISICAL_SECRETS_OUTPUT}`,
    );
  });

  it('the S3_* keys seeded by the CLI are the ones the output produces', () => {
    const outputs = read('outputs.tf');
    for (const key of S3_SECRET_KEYS) {
      expect(outputs, key).toContain(key);
    }
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
});
