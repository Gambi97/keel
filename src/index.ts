#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import {
  ConfigError,
  finalizeAnswers,
  fromEnv,
  hydrateConfigFromManifest,
  mergeAnswers,
  missingRequired,
  parseEnvironments,
  validateContainerSize,
  type Answers,
  type PartialAnswers,
} from './config.js';
import { CI_SECRET_NAMES, CI_VARIABLE_NAMES, resourceName } from './contracts.js';
import { generateProject, GenerateError, readManifest } from './generate.js';
import { toolVersion } from './meta.js';
import { confirmSummary, fillMissing } from './prompts.js';
import { runTeardown } from './teardown.js';
import {
  isDone,
  loadState,
  markDone,
  STATE_FILE,
  stepData,
  stepWarning,
  type RunState,
  type StepName,
} from './state.js';
import { cancel, intro, log, outro, renderNextSteps, renderSummary, withSpinner } from './ui.js';
import { ensureStateBucket, validateScalewayCredentials } from './bootstrap/scaleway.js';
import { bootstrapInfisical, validateInfisical } from './bootstrap/infisical.js';
import {
  assertRepoUsable,
  configureRepo,
  createContext,
  detectOrigin,
  ensureRepo,
  getOriginUrl,
  inspectRepo,
  pushRepo,
  type GitHubContext,
} from './bootstrap/github.js';

/**
 * Single source of truth for the CLI surface: parseArgs consumes these specs
 * and --help is generated from CLI_HELP, whose keys the compiler checks
 * against this table — a flag cannot be added without help text, or vice
 * versa. (The README's CLI reference is the one remaining manual copy.)
 */
const CLI_OPTIONS = {
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
  'infisical-project-id': { type: 'string' },
  'infisical-project-name': { type: 'string' },
  'github-token': { type: 'string' },
  'repo-name': { type: 'string' },
  private: { type: 'boolean' },
  public: { type: 'boolean' },
  environments: { type: 'string' },
  'basic-auth': { type: 'boolean' },
  'no-basic-auth': { type: 'boolean' },
  'object-storage': { type: 'boolean' },
  'no-object-storage': { type: 'boolean' },
  'container-size': { type: 'string' },
  'dev-min-scale': { type: 'string' },
  'dev-max-scale': { type: 'string' },
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
} satisfies Record<string, { type: 'string' | 'boolean' }>;

interface HelpEntry {
  /** Value placeholder shown next to the flag, e.g. `<name>`. */
  hint?: string;
  /** Description; extra lines continue in the description column. */
  text: string;
}

/** Help text per flag; null hides it (help/version share a closing line). */
const CLI_HELP: Record<keyof typeof CLI_OPTIONS, HelpEntry | null> = {
  name: { hint: '<name>', text: 'Project name (dns-safe)' },
  dir: { hint: '<path>', text: 'Target directory (default: the current directory)' },
  region: { hint: '<region>', text: 'fr-par | nl-ams | pl-waw (default: fr-par)' },
  'scw-access-key': { hint: '<key>', text: 'Scaleway access key        (env SCW_ACCESS_KEY)' },
  'scw-secret-key': { hint: '<key>', text: 'Scaleway secret key        (env SCW_SECRET_KEY)' },
  'scw-project-id': {
    hint: '<id>',
    text: 'Scaleway project ID        (env SCW_DEFAULT_PROJECT_ID)',
  },
  'scw-organization-id': {
    hint: '<id>',
    text: 'Scaleway organization ID   (env SCW_DEFAULT_ORGANIZATION_ID)',
  },
  'infisical-host': { hint: '<url>', text: 'Infisical host             (env INFISICAL_HOST)' },
  'infisical-client-id': {
    hint: '<id>',
    text: 'Machine identity client ID (env INFISICAL_CLIENT_ID)',
  },
  'infisical-client-secret': {
    hint: '<s>',
    text: 'Machine identity secret    (env INFISICAL_CLIENT_SECRET)',
  },
  'infisical-project-id': {
    hint: '<id>',
    text: 'Existing Infisical project ID to reuse\n(env INFISICAL_PROJECT_ID; default: create by name)',
  },
  'infisical-project-name': { hint: '<n>', text: 'Infisical project name (default: project name)' },
  'github-token': { hint: '<token>', text: 'GitHub token, repo+workflow (env GITHUB_TOKEN)' },
  'repo-name': {
    hint: '<name>',
    text: 'Repo to create when the directory has no git remote\n(default: <project>-infrastructure; ignored if origin is set)',
  },
  private: { text: 'Create the GitHub repository as private' },
  public: { text: 'Create the GitHub repository as public (default)' },
  environments: {
    hint: '<preset>',
    text: 'prod | staging+prod | dev+staging+prod\n(or a list like "dev,staging,prod"; default staging+prod)',
  },
  'basic-auth': { text: 'Enable Basic Auth on non-production environments (default)' },
  'no-basic-auth': { text: 'Disable Basic Auth on non-production environments' },
  'object-storage': { text: 'Provision a per-environment Object Storage bucket' },
  'no-object-storage': { text: 'Do not provision Object Storage (default)' },
  'container-size': {
    hint: '<size>',
    text: 'Per-instance resources: 100m | 250m | 500m | 1000m\n(mvCPU; default 500m = 500 mvCPU / 1024 MB)',
  },
  'dev-min-scale': { hint: '<n>', text: 'Dev min instances (default 0)' },
  'dev-max-scale': { hint: '<n>', text: 'Dev max instances (default 1)' },
  'staging-min-scale': { hint: '<n>', text: 'Staging min instances (default 0)' },
  'staging-max-scale': { hint: '<n>', text: 'Staging max instances (default 1)' },
  'prod-min-scale': { hint: '<n>', text: 'Prod min instances (default 0)' },
  'prod-max-scale': { hint: '<n>', text: 'Prod max instances (default 1)' },
  config: { hint: '<file.json>', text: 'Read answers from a JSON config file' },
  advanced: { text: 'Also ask scaling questions interactively' },
  yes: { text: 'Accept defaults, no confirmation prompt' },
  'dry-run': { text: 'Generate files locally, touch no account' },
  help: null,
  version: null,
};

const HELP_COLUMN = 33;

function buildHelp(): string {
  const lines = [
    'keel: generate and bootstrap serverless infra on Scaleway',
    '',
    'Usage:',
    '  npx @gambi97/keel-cli [options]            create and bootstrap a project',
    "  npx @gambi97/keel-cli teardown [options]   delete a project's Scaleway/Infisical resources",
    '',
    'Options:',
  ];
  for (const [flag, entry] of Object.entries(CLI_HELP)) {
    if (!entry) continue;
    const head = `  --${flag}${entry.hint ? ` ${entry.hint}` : ''}`;
    const [first, ...rest] = entry.text.split('\n');
    lines.push(head.padEnd(HELP_COLUMN) + first);
    for (const continuation of rest) {
      lines.push(' '.repeat(HELP_COLUMN) + continuation);
    }
  }
  lines.push('  --help, --version');
  return `${lines.join('\n')}\n`;
}

interface Flags {
  yes: boolean;
  dryRun: boolean;
  advanced: boolean;
}

function parseCli(argv: string[]): { partial: PartialAnswers; flags: Flags; command?: string } {
  const { values, positionals } = parseArgs({
    args: argv,
    options: CLI_OPTIONS,
    allowPositionals: true,
  });
  const command = positionals[0];
  if (positionals.length > 1 || (command !== undefined && command !== 'teardown')) {
    cancel(`Unknown command "${positionals.join(' ')}". The only command is "teardown".`);
  }

  if (values.help) {
    process.stdout.write(buildHelp());
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
      projectId: values['infisical-project-id'],
      projectName: values['infisical-project-name'],
    },
    github: {
      token: values['github-token'],
      repoName: values['repo-name'],
      repoPrivate: values.private ? true : values.public ? false : undefined,
    },
    environments: values.environments ? parseEnvironments(values.environments) : undefined,
    basicAuth: values['no-basic-auth'] ? false : values['basic-auth'],
    objectStorage: values['no-object-storage'] ? false : values['object-storage'],
    containerSize: values['container-size']
      ? validateContainerSize(values['container-size'])
      : undefined,
    scaling: {
      dev: { minScale: num(values['dev-min-scale']), maxScale: num(values['dev-max-scale']) },
      staging: {
        minScale: num(values['staging-min-scale']),
        maxScale: num(values['staging-max-scale']),
      },
      prod: { minScale: num(values['prod-min-scale']), maxScale: num(values['prod-max-scale']) },
    },
  };

  return {
    partial: mergeAnswers(fromEnv(process.env), fileAnswers, flagAnswers),
    flags: {
      yes: values.yes ?? false,
      dryRun: values['dry-run'] ?? false,
      advanced: values.advanced ?? false,
    },
    ...(command !== undefined ? { command } : {}),
  };
}

/** Config files use the same nested shape as PartialAnswers. */
function normalizeConfigFile(raw: unknown): PartialAnswers {
  const obj = (raw ?? {}) as Record<string, unknown>;
  let environments: string[] | undefined;
  if (typeof obj.environments === 'string') {
    environments = parseEnvironments(obj.environments);
  } else if (Array.isArray(obj.environments)) {
    environments = obj.environments as string[];
  }
  return mergeAnswers({
    projectName: obj.projectName as string | undefined,
    region: obj.region as string | undefined,
    targetDir: obj.targetDir as string | undefined,
    // `basicAuthStaging` is accepted as a legacy alias for `basicAuth`.
    basicAuth: (obj.basicAuth ?? obj.basicAuthStaging) as boolean | undefined,
    objectStorage: obj.objectStorage as boolean | undefined,
    containerSize: obj.containerSize as string | undefined,
    environments,
    scaleway: (obj.scaleway ?? {}) as PartialAnswers['scaleway'],
    infisical: (obj.infisical ?? {}) as PartialAnswers['infisical'],
    github: (obj.github ?? {}) as PartialAnswers['github'],
    scaling: (obj.scaling ?? {}) as PartialAnswers['scaling'],
  });
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
  const envList = answers.environments.map((e) => e.slug).join(', ');
  const ghEnvs = answers.environments.map((e) => e.githubEnvironment).join('/');
  log.info(
    [
      'Dry run: generated the repository locally. A real run would additionally:',
      `  - Scaleway: create the Terraform state bucket "${answers.stateBucket}" (${answers.region}),`,
      '    restricted by a bucket policy to the identity behind your API key',
      `  - Infisical: ${
        answers.infisical.projectId
          ? `reuse project ${answers.infisical.projectId}`
          : `create/reuse project "${answers.infisical.projectName}"`
      }, environments ${envList},`,
      '    seed BASIC_AUTH_USER/BASIC_AUTH_PASSWORD (non-prod) and DATABASE_URL/APP_URL placeholders' +
        (answers.objectStorage ? ' and S3_* placeholders' : ''),
      `  - GitHub: create or reuse ${answers.github.repoPrivate ? 'private' : 'public'} repo "${answers.github.repoName}", push, set ${CI_SECRET_NAMES.length} encrypted secrets,`,
      `    ${CI_VARIABLE_NAMES.length} variables, ${ghEnvs} environments and main branch protection`,
    ].join('\n'),
  );
}

interface StepResult {
  /** Recorded in the state file for later steps and resumed runs. */
  data?: Record<string, string>;
  /** Non-fatal problem worth surfacing after the spinner. */
  warning?: string;
}

interface BootstrapStep {
  name: StepName;
  label: (answers: Answers, ctx: GitHubContext) => string;
  skipMessage: string;
  run: (answers: Answers, ctx: GitHubContext, state: RunState) => Promise<StepResult | void>;
}

/**
 * The bootstrap pipeline, in order. Each step is idempotent on the provider
 * side and recorded in the state file, so a re-run after a failure skips what
 * is done and resumes exactly where it stopped.
 */
const BOOTSTRAP_STEPS: BootstrapStep[] = [
  {
    name: 'scaleway-bucket',
    label: () => 'Creating Terraform state bucket',
    skipMessage: 'Scaleway state bucket: already done, skipping.',
    run: async (answers) => {
      const { policyWarning } = await ensureStateBucket(answers);
      return policyWarning ? { warning: policyWarning } : undefined;
    },
  },
  {
    name: 'infisical',
    label: () => 'Bootstrapping Infisical project and secrets',
    skipMessage: 'Infisical project: already done, skipping.',
    run: async (answers) => {
      const { projectId, createdProject } = await bootstrapInfisical(answers);
      // Ownership is recorded for teardown: a project keel merely reused
      // (an explicit --infisical-project-id) is not keel's to delete.
      return { data: { projectId, createdProject: String(createdProject) } };
    },
  },
  {
    name: 'github-repo',
    label: (_answers, ctx) => `Creating GitHub repository ${ctx.owner}/${ctx.repo}`,
    skipMessage: 'GitHub repository: already done, skipping.',
    run: async (_answers, ctx) => {
      const { url } = await ensureRepo(ctx);
      return { data: { url } };
    },
  },
  {
    name: 'github-push',
    label: () => 'Pushing generated code to GitHub',
    skipMessage: 'GitHub push: already done, skipping.',
    run: async (answers, ctx) => {
      pushRepo(ctx, answers.github.token, answers.targetDir);
    },
  },
  {
    name: 'github-config',
    label: () => 'Setting GitHub secrets, variables and branch protection',
    skipMessage: 'GitHub configuration: already done, skipping.',
    run: async (answers, ctx, state) => {
      // Recorded by the infisical step (this run or a resumed one).
      const warning = await configureRepo(
        ctx,
        answers,
        stepData(state, 'infisical', 'projectId') as string,
      );
      return warning ? { warning } : undefined;
    },
  },
];

async function runBootstrap(
  answers: Answers,
  state: RunState,
  options: { preValidated: boolean },
): Promise<string> {
  let ctx!: GitHubContext;
  if (options.preValidated) {
    // Interactive runs validated each provider inline while prompting; only
    // the GitHub context (octokit + owner) needs to be rebuilt here.
    ctx = await createContext(answers.github, answers.targetDir);
  } else {
    // All three credentials are checked before anything is created anywhere,
    // so a bad token cannot leave a half-bootstrapped account behind.
    let scalewayWarning: string | undefined;
    await withSpinner('Validating Scaleway, Infisical and GitHub credentials', async () => {
      scalewayWarning = (await validateScalewayCredentials(answers.scaleway)).warning;
      await validateInfisical(answers.infisical);
      ctx = await createContext(answers.github, answers.targetDir);
      // A repo with commits would make the push fail after the bucket and the
      // Infisical project were already created: fail here instead. Skipped on
      // resume, where the previous run's push is the reason it is non-empty.
      if (!isDone(state, 'github-push')) {
        const { state: repoState } = await inspectRepo(ctx);
        assertRepoUsable(ctx, repoState);
      }
    });
    if (scalewayWarning) log.warn(scalewayWarning);
  }

  for (const step of BOOTSTRAP_STEPS) {
    if (isDone(state, step.name)) {
      log.info(step.skipMessage);
      continue;
    }
    // A step that degraded with a warning last run is re-run (idempotent) so
    // the degraded part can heal — e.g. a bucket policy that raced creation.
    if (stepWarning(state, step.name)) {
      log.info('Previous run finished this step with a warning — retrying it.');
    }
    const result = await withSpinner(step.label(answers, ctx), () => step.run(answers, ctx, state));
    markDone(answers.targetDir, state, step.name, result?.data, result?.warning);
    if (result?.warning) log.warn(result.warning);
  }

  return stepData(state, 'github-repo', 'url') as string;
}

async function main(): Promise<void> {
  const { partial, flags, command } = parseCli(process.argv.slice(2));

  if (command === 'teardown') {
    return runTeardown(partial, flags);
  }

  intro(toolVersion());
  checkEnvironment();

  const interactive = process.stdin.isTTY && !flags.yes;
  let collected = partial;
  if (interactive) {
    collected = await fillMissing(partial, { advanced: flags.advanced, dryRun: flags.dryRun });
  } else if (!flags.dryRun) {
    // Resuming non-interactively: lock configuration to the committed manifest
    // so flags/defaults can't silently diverge from the generated repo (e.g. a
    // resume without --object-storage must not flip it off). Same source of
    // truth as the interactive path.
    const resumeDir = partial.targetDir?.trim() || process.cwd();
    const manifest = readManifest(resumeDir);
    if (manifest && manifest.projectName === partial.projectName) {
      hydrateConfigFromManifest(partial, manifest);
      log.info(`Resuming "${manifest.projectName}" — configuration locked to its .keel manifest.`);
    }
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

  // keel generates in place. Resolve the repository from the directory's origin
  // once, for every code path: adopt a github.com origin (recording its real
  // name so the manifest and summary match what is actually pushed), and refuse
  // a remote keel cannot target rather than create a repo and push the code
  // somewhere else. Skipped in a dry run, which touches no remote.
  if (!flags.dryRun) {
    const targetDir = collected.targetDir?.trim() || process.cwd();
    const origin = detectOrigin(targetDir);
    if (origin) {
      collected.github.repoName = origin.repo;
    } else {
      const originUrl = getOriginUrl(targetDir);
      if (originUrl) {
        cancel(
          `This directory's "origin" remote (${originUrl}) is not a github.com URL keel ` +
            'can use, so keel cannot tell where to push. Remove it, or point it at the ' +
            'GitHub repository keel should use (https://github.com/<owner>/<repo>.git).',
        );
      }
    }
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
    const where = answers.targetDir === process.cwd() ? 'the current directory' : answers.targetDir;
    await withSpinner(`Generating repository in ${where}`, async () => {
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

  const repoUrl = await runBootstrap(answers, state, { preValidated: interactive });
  outro(
    renderNextSteps(
      answers,
      repoUrl,
      `rg.${answers.region}.scw.cloud/${resourceName(answers.projectName, answers.environments[0]!.slug)}`,
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
        `${STATE_FILE} inside the project directory: re-run the same ` +
        'command to resume from where it failed. Already-created resources are reused, never duplicated.',
    );
  }
  process.exit(1);
});
