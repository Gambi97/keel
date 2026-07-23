import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { finalizeAnswers } from './config.js';
import { generateProject, GenerateError, MANIFEST_FILE, readManifest } from './generate.js';

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
      '.github/workflows/terraform-drift.yml',
      '.github/scripts/sync-secrets.sh',
      MANIFEST_FILE,
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
    expect(tfvars).toMatch(/project_name\s+= "demo-app"/);
    expect(tfvars).toMatch(/environment\s+= "staging"/);
    expect(tfvars).toMatch(/enable_basic_auth\s+= true/);
    expect(tfvars).toMatch(/enable_object_storage\s+= false/);
    // Container resources are always rendered, so the growth knob is visible
    // in the tfvars instead of hidden in the module defaults.
    expect(tfvars).toMatch(/cpu_limit\s+= 500/);
    expect(tfvars).toMatch(/memory_limit\s+= 1024/);
    // Day zero ships keel's placeholder page from the environment's OWN
    // registry (the apply workflow seeds it there): the first apply brings a
    // container up with no runtime dependency on an external registry.
    expect(tfvars).toContain(
      'container_image = "rg.fr-par.scw.cloud/demo-app-staging/keel-placeholder:v2"',
    );

    // The apply workflow: non-prod deploys on merge to main, prod on a tag.
    const apply = readFileSync(join(target, '.github/workflows/terraform-apply.yml'), 'utf8');
    expect(apply).toContain('apply-staging:');
    expect(apply).toContain('apply-prod:');
    expect(apply).toContain('branches: [main]');
    expect(apply).toContain('tags: ["v*.*.*"]');
    // staging runs on merge, prod runs only on a version tag.
    expect(apply).toContain("if: github.ref == 'refs/heads/main'");
    expect(apply).toContain("if: startsWith(github.ref, 'refs/tags/')");
    // prod is promoted by the tag, not chained after staging.
    expect(apply).not.toContain('needs: apply-staging');
    expect(apply).toContain('environment: production');
    expect(apply).toContain('./.github/scripts/sync-secrets.sh prod');

    // The committed manifest records what the repo was generated with.
    const manifest = JSON.parse(readFileSync(join(target, MANIFEST_FILE), 'utf8')) as {
      keelVersion: string;
      contractVersion: number;
      projectName: string;
      environments: string[];
      options: { objectStorage: boolean; basicAuth: boolean };
      github: { repoName: string; repoPrivate: boolean };
    };
    expect(manifest.projectName).toBe('demo-app');
    expect(manifest.environments).toEqual(['staging', 'prod']);
    expect(manifest.contractVersion).toBeGreaterThanOrEqual(1);
    expect(manifest.options.objectStorage).toBe(false);
    // The repo identity is recorded so a resume locks it instead of re-running
    // the picker (which would frame the project's own repo as "create new").
    expect(manifest.github.repoName).toBe('demo-app-infrastructure');
    expect(manifest.github.repoPrivate).toBe(false);
    // The resume file is ignored, the manifest directory must not be:
    // check actual ignore rules, not comments.
    const gitignoreRules = readFileSync(join(target, '.gitignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    expect(gitignoreRules).toContain('.keel.json');
    expect(gitignoreRules.some((r) => r.startsWith('.keel/'))).toBe(false);

    const backend = readFileSync(join(target, 'backend.hcl.example'), 'utf8');
    expect(backend).toContain('bucket = "demo-app-tfstate"');
    expect(backend).toContain('https://s3.fr-par.scw.cloud');

    // A ready-to-use backend.hcl is materialized (and git-ignored).
    expect(existsSync(join(target, 'backend.hcl'))).toBe(true);
    expect(readFileSync(join(target, '.gitignore'), 'utf8')).toContain('backend.hcl');

    // Pipeline helper script must be executable.
    const mode = statSync(join(target, '.github/scripts/sync-secrets.sh')).mode;
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

  it('generates in place into an existing empty git repository', () => {
    // keel runs inside a directory the user already `git init`ed: .git and the
    // resume file are not content, so generation proceeds.
    dir = mkdtempSync(join(tmpdir(), 'keel-inplace-'));
    execSync('git init -b main', { cwd: dir });
    writeFileSync(join(dir, '.keel.json'), '{}');
    const written = generateProject(sampleAnswers(dir), { git: false });
    expect(written).toContain('README.md');
    expect(existsSync(join(dir, 'main.tf'))).toBe(true);
  });

  it('normalizes an adopted repo on master to main', () => {
    // A directory `git init`ed on master (git's default on many installs) must
    // end on main, or the push to `main` would fail after providers exist.
    dir = mkdtempSync(join(tmpdir(), 'keel-master-'));
    execSync('git init -b master', { cwd: dir });
    generateProject(sampleAnswers(dir));
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir }).toString().trim();
    expect(branch).toBe('main');
  });

  it('reads back the manifest it wrote (resume source of truth)', () => {
    dir = mkdtempSync(join(tmpdir(), 'keel-manifest-'));
    const target = join(dir, 'demo-app');
    generateProject(sampleAnswers(target), { git: false });
    const manifest = readManifest(target);
    expect(manifest?.projectName).toBe('demo-app');
    expect(manifest?.region).toBe('fr-par');
    expect(manifest?.environments).toEqual(['staging', 'prod']);
    expect(manifest?.options.basicAuth).toBe(true);
    expect(manifest?.github?.repoName).toBe('demo-app-infrastructure');
    expect(manifest?.github?.repoPrivate).toBe(false);
  });

  it('returns undefined when there is no manifest (a fresh run)', () => {
    dir = mkdtempSync(join(tmpdir(), 'keel-nomanifest-'));
    expect(readManifest(dir)).toBeUndefined();
  });
});
