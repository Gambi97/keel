import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Answers } from './config.js';
import { STATE_FILE } from './state.js';

export class GenerateError extends Error {}

/** Files whose real name would confuse npm packaging are stored renamed. */
const RENAMES: Record<string, string> = {
  _gitignore: '.gitignore',
};

export function templatesDir(): string {
  return fileURLToPath(new URL('../templates', import.meta.url));
}

/** Global tokens shared by every non per-environment template. */
export function tokenMap(answers: Answers): Record<string, string> {
  const slugs = answers.environments.map((e) => e.slug);
  return {
    __PROJECT_NAME__: answers.projectName,
    __REGION__: answers.region,
    __TF_STATE_BUCKET__: answers.stateBucket,
    // HCL list for the `environment` variable validation in variables.tf.
    __ENV_SLUGS_TF__: `[${slugs.map((s) => `"${s}"`).join(', ')}]`,
  };
}

/** Tokens for one rendered `<env>.tfvars` file. */
function envTfvarsTokens(
  answers: Answers,
  env: Answers['environments'][number],
): Record<string, string> {
  return {
    __PROJECT_NAME__: answers.projectName,
    __REGION__: answers.region,
    __ENVIRONMENT__: env.slug,
    __ENABLE_BASIC_AUTH__: String(env.basicAuth),
    __ENABLE_OBJECT_STORAGE__: String(answers.objectStorage),
    __MIN_SCALE__: String(env.minScale),
    __MAX_SCALE__: String(env.maxScale),
  };
}

/**
 * Templates rendered specially (per environment) instead of copied 1:1.
 *
 * Keep this set small: the templating here is plain token replacement by
 * design. A conditional feature must become a Terraform variable rendered
 * into tfvars (as enable_object_storage does), never a conditionally emitted
 * file — the day a feature cannot be expressed that way is the day to adopt
 * a real template engine, not to add another special case here.
 */
const SPECIAL_TEMPLATES = new Set(['env.tfvars', '.github/workflows/terraform-apply.yml']);

function isSpecial(rel: string): boolean {
  return SPECIAL_TEMPLATES.has(rel) || rel.startsWith('_partials/');
}

/**
 * Assemble the apply workflow: the shared header, then one job per environment
 * in deploy order, each `needs:` the previous so applies run sequentially.
 */
function renderApplyWorkflow(
  source: string,
  answers: Answers,
  globalTokens: Record<string, string>,
): string {
  const header = renderContent(
    readFileSync(join(source, '_partials/apply-header.yml'), 'utf8'),
    globalTokens,
    '_partials/apply-header.yml',
  );
  const jobTemplate = readFileSync(join(source, '_partials/apply-job.yml'), 'utf8');
  const jobs = answers.environments.map((env, i) => {
    const previous = answers.environments[i - 1];
    return renderContent(
      jobTemplate,
      {
        __ENV_SLUG__: env.slug,
        __GH_ENVIRONMENT__: env.githubEnvironment,
        __NEEDS_LINE__: previous ? `    needs: apply-${previous.slug}\n` : '',
      },
      '_partials/apply-job.yml',
    );
  });
  return header + jobs.join('\n');
}

function renderContent(content: string, tokens: Record<string, string>, file: string): string {
  let out = content;
  for (const [token, value] of Object.entries(tokens)) {
    out = out.replaceAll(token, value);
  }
  const leftover = out.match(/__[A-Z0-9_]+__/);
  if (leftover) {
    throw new GenerateError(`Template ${file} contains an unknown token: ${leftover[0]}`);
  }
  return out;
}

function walk(dir: string, base = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...walk(join(dir, entry.name), rel));
    } else {
      files.push(rel);
    }
  }
  return files;
}

export interface GenerateOptions {
  /** Skip git init/commit (used by tests). */
  git?: boolean;
}

/** Render all templates into targetDir and create the initial git commit. */
export function generateProject(answers: Answers, options: GenerateOptions = {}): string[] {
  const source = templatesDir();
  const tokens = tokenMap(answers);
  const target = answers.targetDir;

  if (existsSync(target) && readdirSync(target).some((f) => f !== STATE_FILE)) {
    throw new GenerateError(
      `Directory "${target}" already exists and is not empty. ` +
        'Pick a different name with --dir or remove it first.',
    );
  }
  mkdirSync(target, { recursive: true });

  const written: string[] = [];
  for (const rel of walk(source)) {
    if (isSpecial(rel)) continue;
    const parts = rel.split('/');
    const fileName = parts[parts.length - 1] ?? rel;
    const destRel = [...parts.slice(0, -1), RENAMES[fileName] ?? fileName].join('/');
    const destPath = join(target, destRel);
    mkdirSync(join(target, ...parts.slice(0, -1)), { recursive: true });
    const rendered = renderContent(readFileSync(join(source, rel), 'utf8'), tokens, rel);
    writeFileSync(destPath, rendered);
    if (destRel.endsWith('.sh')) {
      chmodSync(destPath, 0o755);
    }
    written.push(destRel);
  }

  // Per-environment tfvars: one <slug>.tfvars from the shared env.tfvars template.
  const envTemplate = readFileSync(join(source, 'env.tfvars'), 'utf8');
  for (const env of answers.environments) {
    const destRel = `${env.slug}.tfvars`;
    writeFileSync(
      join(target, destRel),
      renderContent(envTemplate, envTfvarsTokens(answers, env), 'env.tfvars'),
    );
    written.push(destRel);
  }

  // Apply workflow: a header plus one deploy job per environment, chained so
  // each environment applies only after the previous one succeeded.
  const applyDestRel = '.github/workflows/terraform-apply.yml';
  writeFileSync(join(target, applyDestRel), renderApplyWorkflow(source, answers, tokens));
  written.push(applyDestRel);

  // backend.hcl (git-ignored) so local terraform runs work out of the box.
  cpSync(join(target, 'backend.hcl.example'), join(target, 'backend.hcl'));

  if (options.git !== false) {
    gitInit(target);
  }
  return written;
}

function run(cwd: string, args: string[], extraEnv: Record<string, string> = {}): void {
  const result = spawnSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) {
    throw new GenerateError(`git ${args[0]} failed: ${result.stderr?.toString().trim()}`);
  }
}

function gitInit(target: string): void {
  if (!existsSync(join(target, '.git'))) {
    run(target, ['init', '-b', 'main']);
  }
  run(target, ['add', '-A']);
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: target });
  if (status.stdout.toString().trim() === '') {
    return; // Nothing to commit (resume case).
  }
  // Fall back to a tool identity when the user has no git identity configured.
  const hasIdentity = spawnSync('git', ['config', 'user.email'], { cwd: target }).status === 0;
  const identity = hasIdentity ? [] : ['-c', 'user.name=keel', '-c', 'user.email=noreply@keel'];
  run(target, [...identity, 'commit', '-m', 'Initial infrastructure from keel']);
}
