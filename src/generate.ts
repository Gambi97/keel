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

export function tokenMap(answers: Answers): Record<string, string> {
  return {
    __PROJECT_NAME__: answers.projectName,
    __REGION__: answers.region,
    __TF_STATE_BUCKET__: answers.stateBucket,
    __STAGING_MIN_SCALE__: String(answers.scaling.stagingMinScale),
    __STAGING_MAX_SCALE__: String(answers.scaling.stagingMaxScale),
    __PROD_MIN_SCALE__: String(answers.scaling.prodMinScale),
    __PROD_MAX_SCALE__: String(answers.scaling.prodMaxScale),
  };
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
