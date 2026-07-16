import { rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  finalizeTeardownAnswers,
  hydrateConfigFromManifest,
  KNOWN_ENV_SLUGS,
  mergeAnswers,
  missingRequiredTeardown,
  type PartialAnswers,
  type TeardownConfig,
} from './config.js';
import { ENV_RESOURCE_SUFFIXES, resourceName } from './contracts.js';
import { readManifest } from './generate.js';
import { toolVersion } from './meta.js';
import { askProjectName, confirmTeardown, fillTeardownCredentials } from './prompts.js';
import { loadState, STATE_FILE, stepData } from './state.js';
import { cancel, intro, log, outro, withSpinner } from './ui.js';
import { deleteProject } from './bootstrap/infisical.js';
import {
  deleteBucket,
  deleteContainerNamespace,
  deleteDatabase,
  deleteIamApplication,
  deleteIamPolicy,
  deleteRegistryNamespace,
  type DeleteOutcome,
} from './bootstrap/scaleway.js';

/**
 * 'kept' is a resource the plan reached but deliberately refused to delete
 * (e.g. an Infisical project keel reused instead of creating).
 */
export type TeardownOutcome = DeleteOutcome | 'kept';

/**
 * One deletable resource. Labels double as the confirmation list shown before
 * anything is touched, so they must name the resource exactly.
 */
export interface TeardownStep {
  label: string;
  run: () => Promise<TeardownOutcome>;
}

export interface TeardownResult {
  label: string;
  outcome: TeardownOutcome | 'failed';
  detail?: string;
}

/**
 * The reverse of the bootstrap + first apply: everything keel and the
 * generated Terraform create on Scaleway and Infisical, deleted by the same
 * naming convention they create it with (find by exact name, skip if absent —
 * re-runnable). The GitHub repository is deliberately NOT part of the plan:
 * it is the source of truth and may hold the user's own commits, the one
 * thing a re-run cannot recreate — deleting it stays a manual, human act.
 *
 * Every known environment is swept, not just the configured selection: an
 * earlier experiment on the same project name may have provisioned more.
 * Terraform state is not consulted — it lives in the state bucket this
 * command deletes, and name-based deletion also catches half-applied runs.
 */
export function teardownPlan(
  config: TeardownConfig,
  options: {
    /**
     * Whether the bootstrap CREATED the Infisical project (recorded in
     * .keel.json) or merely reused an existing one. A reused project is not
     * keel's to delete and is excluded from the plan; when the record is
     * gone, deleteProject itself refuses projects that don't carry keel's
     * default name.
     */
    infisicalCreatedByKeel?: boolean;
  } = {},
): TeardownStep[] {
  const scw = config.scaleway;
  const steps: TeardownStep[] = [];
  for (const slug of KNOWN_ENV_SLUGS) {
    const name = resourceName(config.projectName, slug);
    const s = ENV_RESOURCE_SUFFIXES;
    steps.push(
      {
        label: `Scaleway container namespace "${name}"`,
        run: () => deleteContainerNamespace(scw, config.region, name),
      },
      {
        label: `Scaleway registry namespace "${name}"`,
        run: () => deleteRegistryNamespace(scw, config.region, name),
      },
      {
        label: `Scaleway database "${name}"`,
        run: () => deleteDatabase(scw, config.region, name),
      },
      {
        label: `Scaleway IAM policy "${name}${s.dbIamPolicy}"`,
        run: () => deleteIamPolicy(scw, `${name}${s.dbIamPolicy}`),
      },
      {
        label: `Scaleway IAM policy "${name}${s.storageIamPolicy}"`,
        run: () => deleteIamPolicy(scw, `${name}${s.storageIamPolicy}`),
      },
      {
        label: `Scaleway IAM application "${name}${s.dbIamApplication}"`,
        run: () => deleteIamApplication(scw, `${name}${s.dbIamApplication}`),
      },
      {
        label: `Scaleway IAM application "${name}${s.storageIamApplication}"`,
        run: () => deleteIamApplication(scw, `${name}${s.storageIamApplication}`),
      },
      {
        label: `Scaleway bucket "${name}${s.filesBucket}"`,
        run: () => deleteBucket(config, `${name}${s.filesBucket}`),
      },
    );
  }
  steps.push({
    label: `Scaleway state bucket "${config.stateBucket}"`,
    run: () => deleteBucket(config, config.stateBucket),
  });
  if (options.infisicalCreatedByKeel !== false) {
    steps.push({
      label: `Infisical project "${config.infisical.projectName}"`,
      run: () => deleteProject(config.infisical),
    });
  }
  return steps;
}

/** Run every step, never stopping on a failure: report what happened. */
export async function executeTeardown(
  steps: TeardownStep[],
  onStep: (step: TeardownStep) => Promise<TeardownOutcome>,
): Promise<TeardownResult[]> {
  const results: TeardownResult[] = [];
  for (const step of steps) {
    try {
      results.push({ label: step.label, outcome: await onStep(step) });
    } catch (error) {
      results.push({
        label: step.label,
        outcome: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

const REPO_KEPT_NOTE =
  'The GitHub repository is never touched by teardown — it is your source of truth. ' +
  'Delete it yourself when you are done (repository Settings → Danger Zone).';

/**
 * The `keel teardown` command: delete everything a project created on
 * Scaleway and Infisical, so the name can be reused for a fresh run.
 * Destructive and gated: interactive runs must type the project name back,
 * non-interactive runs must pass --yes, and --dry-run only prints the plan.
 */
export async function runTeardown(
  partial: PartialAnswers,
  flags: { yes: boolean; dryRun: boolean },
): Promise<void> {
  intro(toolVersion());
  const tty = process.stdin.isTTY && !flags.yes;

  const collected = structuredClone(partial);
  if (tty && !collected.projectName) {
    await askProjectName(collected);
  }
  if (!collected.projectName?.trim()) {
    cancel('teardown needs the project name: pass --name <name> (or run interactively).');
  }
  // Fail this fast, before any credential is asked for or checked.
  if (!tty && !flags.dryRun && !flags.yes) {
    cancel('Non-interactive teardown requires --yes to confirm deletion.');
  }

  // The committed manifest (when the generated repo is still on disk) pins
  // the region, exactly like a resumed bootstrap; the local state file
  // recorded the Infisical project ID.
  const targetDir = collected.targetDir?.trim() || collected.projectName!;
  const manifest = readManifest(targetDir);
  if (manifest && manifest.projectName === collected.projectName) {
    hydrateConfigFromManifest(collected, manifest);
    log.info(`Found ./${targetDir} — the region is taken from its .keel manifest.`);
  }
  const state = loadState(targetDir, collected.projectName!);
  if (!collected.infisical.projectId) {
    const recorded = stepData(state, 'infisical', 'projectId');
    if (typeof recorded === 'string' && recorded) collected.infisical.projectId = recorded;
  }
  // Ownership recorded by the bootstrap; undefined for pre-record state files.
  const createdRecord = stepData(state, 'infisical', 'createdProject');
  const infisicalCreatedByKeel =
    createdRecord === 'true' ? true : createdRecord === 'false' ? false : undefined;

  let config: TeardownConfig;
  if (flags.dryRun) {
    // Placeholders keep the finalize happy; nothing is called with them.
    config = finalizeTeardownAnswers(
      mergeAnswers(
        {
          scaleway: {
            accessKey: 'dry-run',
            secretKey: 'dry-run',
            projectId: 'dry-run',
            organizationId: 'dry-run',
          },
          infisical: { clientId: 'dry-run', clientSecret: 'dry-run' },
          github: {},
          scaling: {},
        },
        collected,
      ),
    );
  } else if (tty) {
    // Region and Infisical host are asked too when unknown: deleting in the
    // wrong region/host would report everything "absent" and look like a
    // clean teardown while the real resources survive elsewhere.
    config = finalizeTeardownAnswers(await fillTeardownCredentials(collected));
  } else {
    const missing = missingRequiredTeardown(collected);
    if (missing.length > 0) {
      cancel(`Non-interactive teardown is missing required values:\n  - ${missing.join('\n  - ')}`);
    }
    config = finalizeTeardownAnswers(collected);
  }

  const steps = teardownPlan(config, {
    ...(infisicalCreatedByKeel !== undefined ? { infisicalCreatedByKeel } : {}),
  });
  const reusedNote =
    infisicalCreatedByKeel === false
      ? `\nThe Infisical project was reused at bootstrap, not created — it is NOT keel's to delete and stays.`
      : '';
  const summary = steps.map((step) => `  - ${step.label}`).join('\n') + reusedNote;

  if (flags.dryRun) {
    log.info(
      `Dry run: a real teardown would delete (where present, region ${config.region}):\n${summary}\n${REPO_KEPT_NOTE}`,
    );
    outro('Dry run complete. Nothing was deleted.');
    return;
  }

  if (tty) {
    const confirmed = await confirmTeardown(summary, config.projectName);
    if (!confirmed) cancel('The name did not match. Nothing was deleted.');
  } else {
    // --yes was already required above; show what is being deleted anyway.
    log.info(`Deleting (where present):\n${summary}`);
  }

  const results = await executeTeardown(steps, (step) => withSpinner(step.label, step.run));
  const failed = results.filter((r) => r.outcome === 'failed');
  const deleted = results.filter((r) => r.outcome === 'deleted').length;
  const absent = results.filter((r) => r.outcome === 'absent').length;
  for (const kept of results.filter((r) => r.outcome === 'kept')) {
    log.info(`${kept.label}: reused, not created by keel — left in place.`);
  }
  for (const failure of failed) {
    log.error(`${failure.label}: ${failure.detail ?? 'unknown error'}`);
  }
  if (failed.length > 0) {
    log.warn(
      'Some resources could not be deleted. Fix the cause and re-run the same command: ' +
        'already-deleted resources are skipped.',
    );
    process.exitCode = 1;
    outro(
      `Teardown incomplete: ${deleted} deleted, ${absent} already absent, ${failed.length} failed.`,
    );
    return;
  }
  if (deleted === 0) {
    // Everything "absent" can also mean the wrong coordinates: looking in
    // fr-par for a nl-ams project reports a clean teardown that deleted nothing.
    log.warn(
      `Nothing was found to delete in region ${config.region}. If you expected otherwise, ` +
        'check --region and --infisical-host match the ones the project was created with.',
    );
  }
  // The resume state points at resources that no longer exist.
  rmSync(join(targetDir, STATE_FILE), { force: true });
  outro(
    `Teardown complete: ${deleted} deleted, ${absent} already absent.\n${REPO_KEPT_NOTE}\n` +
      `The local directory ./${targetDir} was kept — remove it yourself if you are done with it.`,
  );
}
