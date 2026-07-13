// Renders the templates with sample values and runs `terraform fmt -check`
// and `terraform validate` on the result. Requires the project to be built
// (npm run build) and terraform on PATH (or TERRAFORM_BIN set).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { finalizeAnswers } = await import('../dist/config.js');
const { generateProject } = await import('../dist/generate.js');

const terraform = process.env.TERRAFORM_BIN ?? 'terraform';
const dir = mkdtempSync(join(tmpdir(), 'keel-verify-'));
const target = join(dir, 'demo-app');

try {
  generateProject(
    finalizeAnswers({
      projectName: 'demo-app',
      region: 'fr-par',
      targetDir: target,
      scaleway: { accessKey: 'ak', secretKey: 'sk', projectId: 'pid', organizationId: 'oid' },
      infisical: { clientId: 'cid', clientSecret: 'cs' },
      github: { token: 'tok' },
      scaling: {},
    }),
    { git: false },
  );

  const tf = (...args) => execFileSync(terraform, args, { cwd: target, stdio: 'inherit' });
  tf('fmt', '-check', '-recursive');
  tf('init', '-backend=false', '-input=false');
  tf('validate');
  console.log('Templates OK: fmt and validate passed.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
