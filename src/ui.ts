import * as p from '@clack/prompts';

import type { Answers } from './config.js';

export const log = p.log;

export function intro(version: string): void {
  p.intro(`keel v${version}`);
}

export function outro(message: string): void {
  p.outro(message);
}

export function cancel(message: string): never {
  p.cancel(message);
  process.exit(1);
}

/** Show only a hint of a secret, never the value itself. */
export function redact(secret: string): string {
  if (secret.length <= 6) return '***';
  return `${secret.slice(0, 4)}…(redacted)`;
}

export async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const spinner = p.spinner();
  spinner.start(label);
  try {
    const result = await fn();
    spinner.stop(`${label} ✓`);
    return result;
  } catch (error) {
    spinner.stop(`${label} ✗`, 1);
    throw error;
  }
}

export function renderSummary(answers: Answers, dryRun: boolean): string {
  const envSlugs = answers.environments.map((e) => e.slug).join(', ');
  const lines = [
    `Project          ${answers.projectName}`,
    `Directory        ./${answers.targetDir}`,
    `Region           ${answers.region}`,
    '',
    'Scaleway',
    `  access key     ${redact(answers.scaleway.accessKey)}`,
    `  project        ${answers.scaleway.projectId}`,
    `  state bucket   ${answers.stateBucket} (will be created)`,
    '',
    'GitHub',
    `  repository     ${answers.github.repoName} (${answers.github.repoPrivate ? 'private' : 'public'}, will be created + pushed)`,
    `  secrets        SCW_*, INFISICAL_* (encrypted)`,
    `  variables      TF_STATE_BUCKET, SCW_REGION, INFISICAL_PROJECT_ID, INFISICAL_HOST`,
    '',
    'Infisical',
    `  host           ${answers.infisical.host}`,
    `  project        ${
      answers.infisical.projectId
        ? `${answers.infisical.projectName} (existing, ${answers.infisical.projectId})`
        : `${answers.infisical.projectName} (will be created)`
    }`,
    `  environments   ${envSlugs} (+ placeholder secrets)`,
    '',
    `Object Storage   ${answers.objectStorage ? 'enabled (per-environment bucket + S3_* secrets)' : 'disabled'}`,
    `Container size   ${answers.containerSize.cpuLimit} mvCPU / ${answers.containerSize.memoryLimit} MB per instance`,
    'Environments',
  ];
  for (const env of answers.environments) {
    const flags = [
      `scale ${env.minScale}-${env.maxScale}`,
      env.production ? 'deploys on version tag' : 'deploys on merge to main',
      env.basicAuth ? 'basic auth' : null,
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(`  ${env.slug.padEnd(8)} ${flags}`);
  }
  if (dryRun) {
    lines.push('', 'DRY RUN: files will be generated locally, no account will be touched.');
  }
  return lines.join('\n');
}

export function renderNextSteps(
  answers: Answers,
  repoUrl: string,
  containerUrlHint: string,
): string {
  return [
    'Next steps:',
    '',
    `  1. Push to main (or merge a PR) to deploy the non-production environments:`,
    `     ${repoUrl}/actions — the first apply already serves keel's placeholder`,
    `     page, so APP_URL is live from day zero.`,
    `  2. Replace the placeholder secrets in Infisical (${answers.infisical.host})`,
    `     project "${answers.infisical.projectName}" with real values.`,
    `  3. Ship your app: push its image to the registry (${containerUrlHint}),`,
    `     then point container_image at it in ${answers.environments.map((e) => `${e.slug}.tfvars`).join(' / ')}.`,
    `  4. Release to production with a version tag: git tag v1.0.0 && git push --tags`,
    '',
    `Repository: ${repoUrl}`,
  ].join('\n');
}
