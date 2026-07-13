import * as p from '@clack/prompts';

import type { Answers } from './config.js';

export const log = p.log;

export function intro(version: string): void {
  p.intro(`create-serverless-app v${version}`);
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
    `  repository     ${answers.github.repoName} (public, will be created + pushed)`,
    `  secrets        SCW_*, AWS_*, INFISICAL_* (encrypted)`,
    `  variables      TF_STATE_BUCKET, SCW_REGION, INFISICAL_PROJECT_ID, INFISICAL_HOST`,
    '',
    'Infisical',
    `  host           ${answers.infisical.host}`,
    `  project        ${answers.infisical.projectName} (created or reused)`,
    `  environments   staging, prod (+ placeholder secrets)`,
    '',
    `Basic Auth on staging   ${answers.basicAuthStaging ? 'enabled' : 'disabled'}`,
    `Scaling staging         ${answers.scaling.stagingMinScale}-${answers.scaling.stagingMaxScale} instances`,
    `Scaling prod            ${answers.scaling.prodMinScale}-${answers.scaling.prodMaxScale} instances`,
  ];
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
    `  1. Add a Dockerfile to your application and push its image to the`,
    `     registry created by the first pipeline run (${containerUrlHint}).`,
    `  2. Replace the placeholder secrets in Infisical (${answers.infisical.host})`,
    `     project "${answers.infisical.projectName}" with real values.`,
    `  3. Push to main (or merge a PR) to trigger the first terraform apply:`,
    `     ${repoUrl}/actions`,
    `  4. Set container_image in staging.tfvars / prod.tfvars once an image exists.`,
    '',
    `Repository: ${repoUrl}`,
  ].join('\n');
}
