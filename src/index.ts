#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  ConfigError,
  finalizeAnswers,
  fromEnv,
  mergeAnswers,
  missingRequired,
  type Answers,
  type PartialAnswers,
} from './config.js';
import { generateProject, GenerateError } from './generate.js';
import { confirmSummary, fillMissing } from './prompts.js';
import { isDone, loadState, markDone, stepData, type RunState } from './state.js';
import { cancel, intro, log, outro, renderNextSteps, renderSummary, withSpinner } from './ui.js';
import { ensureStateBucket, validateScalewayCredentials } from './bootstrap/scaleway.js';
import { bootstrapInfisical } from './bootstrap/infisical.js';
import { configureRepo, createContext, ensureRepo, pushRepo } from './bootstrap/github.js';

const HELP = `create-serverless-app: generate and bootstrap serverless infra on Scaleway

Usage:
  npx create-serverless-app [options]

Options:
  --name <name>                  Project name (dns-safe)
  --dir <path>                   Target directory (default: ./<name>)
  --region <region>              fr-par | nl-ams | pl-waw (default: fr-par)
  --scw-access-key <key>         Scaleway access key        (env SCW_ACCESS_KEY)
  --scw-secret-key <key>         Scaleway secret key        (env SCW_SECRET_KEY)
  --scw-project-id <id>          Scaleway project ID        (env SCW_DEFAULT_PROJECT_ID)
  --scw-organization-id <id>     Scaleway organization ID   (env SCW_DEFAULT_ORGANIZATION_ID)
  --infisical-host <url>         Infisical host             (env INFISICAL_HOST)
  --infisical-client-id <id>     Machine identity client ID (env INFISICAL_CLIENT_ID)
  --infisical-client-secret <s>  Machine identity secret    (env INFISICAL_CLIENT_SECRET)
  --infisical-project-name <n>   Infisical project (default: project name)
  --github-token <token>         GitHub token, repo+workflow (env GITHUB_TOKEN)
  --repo-name <name>             GitHub repository name (default: project name)
  --no-basic-auth                Disable Basic Auth on staging
  --staging-min-scale <n>        Staging min instances (default 0)
  --staging-max-scale <n>        Staging max instances (default 1)
  --prod-min-scale <n>           Prod min instances (default 0)
  --prod-max-scale <n>           Prod max instances (default 2)
  --config <file.json>           Read answers from a JSON config file
  --advanced                     Also ask scaling questions interactively
  --yes                          Accept defaults, no confirmation prompt
  --dry-run                      Generate files locally, touch no account
  --help, --version
`;

interface Flags {
  yes: boolean;
  dryRun: boolean;
  advanced: boolean;
}

function parseCli(argv: string[]): { partial: PartialAnswers; flags: Flags } {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: 'string' },
      dir: { type: 'string' },
      region: { type: 'string' },
      'scw-access-key': { type: 'string' },
      'scw-secret-key': { type: 'string' },
      'scw-project-id': { type: 'string' },
      'scw-organization-id': { type: 'string' },
      'infisical-host': { type: 'string' },
      'infisical-client-id': { type: 'string' },
      'infisical-client-secret': { type: 'string' },
      'infisical-project-name': { type: 'string' },
      'github-token': { type: 'string' },
      'repo-name': { type: 'string' },
      'basic-auth': { type: 'boolean' },
      'no-basic-auth': { type: 'boolean' },
      'staging-min-scale': { type: 'string' },
      'staging-max-scale': { type: 'string' },
      'prod-min-scale': { type: 'string' },
      'prod-max-scale': { type: 'string' },
      config: { type: 'string' },
      advanced: { type: 'boolean' },
      yes: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' },
      version: { type: 'boolean' },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (values.version) {
    process.stdout.write(`${toolVersion()}\n`);
    process.exit(0);
  }

  const fileAnswers: PartialAnswers = values.config
    ? normalizeConfigFile(JSON.parse(readFileSync(values.config, 'utf8')))
    : { scaleway: {}, infisical: {}, github: {}, scaling: {} };

  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  const flagAnswers: PartialAnswers = {
    projectName: values.name,
    targetDir: values.dir,
    region: values.region,
    scaleway: {
      accessKey: values['scw-access-key'],
      secretKey: values['scw-secret-key'],
      projectId: values['scw-project-id'],
      organizationId: values['scw-organization-id'],
    },
    infisical: {
      host: values['infisical-host'],
      clientId: values['infisical-client-id'],
      clientSecret: values['infisical-client-secret'],
      projectName: values['infisical-project-name'],
    },
    github: {
      token: values['github-token'],
      repoName: values['repo-name'],
    },
    basicAuthStaging: values['no-basic-auth'] ? false : values['basic-auth'],
    scaling: {
      stagingMinScale: num(values['staging-min-scale']),
      stagingMaxScale: num(values['staging-max-scale']),
      prodMinScale: num(values['prod-min-scale']),
      prodMaxScale: num(values['prod-max-scale']),
    },
  };

  return {
    partial: mergeAnswers(fromEnv(process.env), fileAnswers, flagAnswers),
    flags: {
      yes: values.yes ?? false,
      dryRun: values['dry-run'] ?? false,
      advanced: values.advanced ?? false,
    },
  };
}

/** Config files use the same nested shape as PartialAnswers. */
function normalizeConfigFile(raw: unknown): PartialAnswers {
  const obj = (raw ?? {}) as Record<string, unknown>;
  return mergeAnswers({
    projectName: obj.projectName as string | undefined,
    region: obj.region as string | undefined,
    targetDir: obj.targetDir as string | undefined,
    basicAuthStaging: obj.basicAuthStaging as boolean | undefined,
    scaleway: (obj.scaleway ?? {}) as PartialAnswers['scaleway'],
    infisical: (obj.infisical ?? {}) as PartialAnswers['infisical'],
    github: (obj.github ?? {}) as PartialAnswers['github'],
    scaling: (obj.scaling ?? {}) as PartialAnswers['scaling'],
  });
}

function toolVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

function checkEnvironment(): void {
  const [major] = process.versions.node.split('.');
  if (Number(major) < 18) {
    cancel(`Node.js >= 18 is required (found ${process.versions.node}).`);
  }
  if (spawnSync('git', ['--version'], { stdio: 'ignore' }).status !== 0) {
    cancel('git is required but was not found on PATH.');
  }
}

function printDryRunPlan(answers: Answers): void {
  log.info(
    [
      'Dry run: generated the repository locally. A real run would additionally:',
      `  - Scaleway: create Object Storage bucket "${answers.stateBucket}" (${answers.region})`,
      `  - Infisical: create/reuse project "${answers.infisical.projectName}", environments staging/prod,`,
      '    seed BASIC_AUTH_USER/BASIC_AUTH_PASSWORD (staging) and DATABASE_URL placeholders',
      `  - GitHub: create public repo "${answers.github.repoName}", push, set 8 encrypted secrets,`,
      '    4 variables, staging/production environments and main branch protection',
    ].join('\n'),
  );
}

async function runBootstrap(answers: Answers, state: RunState): Promise<string> {
  const dir = answers.targetDir;

  if (!isDone(state, 'scaleway-bucket')) {
    await withSpinner('Validating Scaleway credentials and creating state bucket', async () => {
      await validateScalewayCredentials(answers);
      await ensureStateBucket(answers);
    });
    markDone(dir, state, 'scaleway-bucket');
  } else {
    log.info('Scaleway state bucket: already done, skipping.');
  }

  let infisicalProjectId = stepData(state, 'infisical', 'projectId');
  if (!infisicalProjectId) {
    const result = await withSpinner('Bootstrapping Infisical project and secrets', () =>
      bootstrapInfisical(answers),
    );
    infisicalProjectId = result.projectId;
    markDone(dir, state, 'infisical', { projectId: infisicalProjectId });
  } else {
    log.info('Infisical project: already done, skipping.');
  }

  const ctx = await createContext(answers);
  let repoUrl = stepData(state, 'github-repo', 'url');
  if (!repoUrl) {
    const repo = await withSpinner(`Creating GitHub repository ${ctx.owner}/${ctx.repo}`, () =>
      ensureRepo(ctx),
    );
    repoUrl = repo.url;
    markDone(dir, state, 'github-repo', { url: repoUrl });
  } else {
    log.info('GitHub repository: already done, skipping.');
  }

  if (!isDone(state, 'github-push')) {
    await withSpinner('Pushing generated code to GitHub', async () => {
      pushRepo(ctx, answers.github.token, dir);
    });
    markDone(dir, state, 'github-push');
  } else {
    log.info('GitHub push: already done, skipping.');
  }

  if (!isDone(state, 'github-config')) {
    await withSpinner('Setting GitHub secrets, variables and branch protection', () =>
      configureRepo(ctx, answers, infisicalProjectId as string),
    );
    markDone(dir, state, 'github-config');
  } else {
    log.info('GitHub configuration: already done, skipping.');
  }

  return repoUrl;
}

async function main(): Promise<void> {
  const { partial, flags } = parseCli(process.argv.slice(2));

  intro(toolVersion());
  checkEnvironment();

  const interactive = process.stdin.isTTY && !flags.yes;
  let collected = partial;
  if (interactive) {
    collected = await fillMissing(partial, { advanced: flags.advanced });
  } else if (!flags.dryRun) {
    const missing = missingRequired(partial);
    if (missing.length > 0) {
      cancel(`Non-interactive run is missing required values:\n  - ${missing.join('\n  - ')}`);
    }
  }

  // In a dry run, missing credentials are replaced by placeholders: nothing
  // will be validated against or sent to any account.
  if (flags.dryRun) {
    collected = mergeAnswers(
      {
        scaleway: {
          accessKey: 'dry-run',
          secretKey: 'dry-run',
          projectId: 'dry-run',
          organizationId: 'dry-run',
        },
        infisical: { clientId: 'dry-run', clientSecret: 'dry-run' },
        github: { token: 'dry-run' },
        scaling: {},
      },
      collected,
    );
    if (!collected.projectName) collected.projectName = 'my-app';
  }

  const answers = finalizeAnswers(collected);

  const summary = renderSummary(answers, flags.dryRun);
  if (interactive) {
    const confirmed = await confirmSummary(summary);
    if (!confirmed) cancel('Aborted. Nothing was created.');
  } else {
    log.info(summary);
  }

  const state = loadState(answers.targetDir, answers.projectName);

  if (!isDone(state, 'generate')) {
    await withSpinner(`Generating repository in ./${answers.targetDir}`, async () => {
      generateProject(answers);
    });
    markDone(answers.targetDir, state, 'generate');
  } else {
    log.info('Generation: already done, skipping.');
  }

  if (flags.dryRun) {
    printDryRunPlan(answers);
    outro('Dry run complete. No account was touched.');
    return;
  }

  const repoUrl = await runBootstrap(answers, state);
  outro(
    renderNextSteps(
      answers,
      repoUrl,
      `rg.${answers.region}.scw.cloud/${answers.projectName}-staging`,
    ),
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof GenerateError) {
    log.error(error.message);
  } else {
    log.error(error instanceof Error ? error.message : String(error));
    log.warn(
      'The run stopped before completing. Completed steps are recorded in ' +
        '.create-serverless-app.json inside the project directory: re-run the same ' +
        'command to resume from where it failed. Already-created resources are reused, never duplicated.',
    );
  }
  process.exit(1);
});
