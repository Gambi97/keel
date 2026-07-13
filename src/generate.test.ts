import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { finalizeAnswers } from './config.js';
import { generateProject, GenerateError } from './generate.js';

function sampleAnswers(targetDir: string) {
  return finalizeAnswers({
    projectName: 'demo-app',
    region: 'fr-par',
    targetDir,
    scaleway: { accessKey: 'ak', secretKey: 'sk', projectId: 'pid', organizationId: 'oid' },
    infisical: { clientId: 'cid', clientSecret: 'cs' },
    github: { token: 'tok' },
    scaling: {},
  });
}

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('generateProject', () => {
  it('renders the full repository without leftover tokens', () => {
    dir = mkdtempSync(join(tmpdir(), 'keel-gen-'));
    const target = join(dir, 'demo-app');
    const written = generateProject(sampleAnswers(target), { git: false });

    for (const expected of [
      'README.md',
      'LICENSE',
      '.gitignore',
      'versions.tf',
      'providers.tf',
      'backend.tf',
      'backend.hcl.example',
      'variables.tf',
      'main.tf',
      'outputs.tf',
      'staging.tfvars',
      'prod.tfvars',
      'modules/app_stack/main.tf',
      'modules/app_stack/variables.tf',
      'modules/app_stack/outputs.tf',
      '.github/workflows/terraform-plan.yml',
      '.github/workflows/terraform-apply.yml',
      '.github/scripts/sync-database-url.sh',
    ]) {
      expect(written, expected).toContain(expected);
      expect(existsSync(join(target, expected)), expected).toBe(true);
    }

    // No template token may survive rendering.
    for (const file of written) {
      const content = readFileSync(join(target, file), 'utf8');
      expect(content, file).not.toMatch(/__[A-Z0-9_]+__/);
    }

    const tfvars = readFileSync(join(target, 'staging.tfvars'), 'utf8');
    expect(tfvars).toContain('project_name      = "demo-app"');
    expect(tfvars).toContain('enable_basic_auth = true');

    const backend = readFileSync(join(target, 'backend.hcl.example'), 'utf8');
    expect(backend).toContain('bucket = "demo-app-tfstate"');
    expect(backend).toContain('https://s3.fr-par.scw.cloud');

    // A ready-to-use backend.hcl is materialized (and git-ignored).
    expect(existsSync(join(target, 'backend.hcl'))).toBe(true);
    expect(readFileSync(join(target, '.gitignore'), 'utf8')).toContain('backend.hcl');

    // Pipeline helper script must be executable.
    const mode = statSync(join(target, '.github/scripts/sync-database-url.sh')).mode;
    expect(mode & 0o100).toBeTruthy();

    // The _gitignore rename must not leak the placeholder name.
    expect(existsSync(join(target, '_gitignore'))).toBe(false);
  });

  it('creates an initial git commit on main', () => {
    dir = mkdtempSync(join(tmpdir(), 'keel-git-'));
    const target = join(dir, 'demo-app');
    generateProject(sampleAnswers(target));
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: target }).toString().trim();
    expect(branch).toBe('main');
    const status = execSync('git status --porcelain', { cwd: target }).toString().trim();
    expect(status).toBe('');
  });

  it('refuses to overwrite a non-empty directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'keel-clash-'));
    writeFileSync(join(dir, 'existing.txt'), 'hello');
    expect(() => generateProject(sampleAnswers(dir), { git: false })).toThrow(GenerateError);
  });
});
