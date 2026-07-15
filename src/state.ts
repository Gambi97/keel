import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STATE_FILE = '.keel.json';

export type StepName =
  'generate' | 'scaleway-bucket' | 'infisical' | 'github-repo' | 'github-push' | 'github-config';

export interface RunState {
  version: 1;
  projectName: string;
  /**
   * Steps completed so far, with any data later steps need (never secrets).
   * A step recorded with a warning finished in degraded form (e.g. the bucket
   * policy could not be applied): it is NOT done — a resume re-runs it, which
   * is safe because every step is find-or-create idempotent, and gives the
   * degraded part a chance to heal.
   */
  steps: Partial<Record<StepName, { data?: Record<string, string>; warning?: string }>>;
}

export function loadState(targetDir: string, projectName: string): RunState {
  try {
    const raw = readFileSync(join(targetDir, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as RunState;
    if (parsed.version === 1 && parsed.projectName === projectName) {
      return parsed;
    }
  } catch {
    // No resume file or unreadable: start fresh.
  }
  return { version: 1, projectName, steps: {} };
}

export function saveState(targetDir: string, state: RunState): void {
  writeFileSync(join(targetDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

export function isDone(state: RunState, step: StepName): boolean {
  const record = state.steps[step];
  return record !== undefined && record.warning === undefined;
}

/** The warning a previous run recorded for this step, if it degraded. */
export function stepWarning(state: RunState, step: StepName): string | undefined {
  return state.steps[step]?.warning;
}

export function markDone(
  targetDir: string,
  state: RunState,
  step: StepName,
  data?: Record<string, string>,
  warning?: string,
): void {
  state.steps[step] = { ...(data ? { data } : {}), ...(warning ? { warning } : {}) };
  saveState(targetDir, state);
}

export function stepData(state: RunState, step: StepName, key: string): string | undefined {
  return state.steps[step]?.data?.[key];
}
