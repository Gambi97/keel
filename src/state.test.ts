import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isDone, loadState, markDone, stepWarning } from './state.js';

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('run state', () => {
  it('a step completed cleanly is done and skipped on resume', () => {
    dir = mkdtempSync(join(tmpdir(), 'keel-state-'));
    const state = loadState(dir, 'app');
    markDone(dir, state, 'scaleway-bucket');
    expect(isDone(state, 'scaleway-bucket')).toBe(true);
    // And it survives a reload (what an actual resume does).
    expect(isDone(loadState(dir, 'app'), 'scaleway-bucket')).toBe(true);
  });

  it('a step that degraded with a warning is NOT done: resume re-runs it', () => {
    dir = mkdtempSync(join(tmpdir(), 'keel-state-warn-'));
    const state = loadState(dir, 'app');
    markDone(dir, state, 'scaleway-bucket', undefined, 'policy could not be applied');
    expect(isDone(state, 'scaleway-bucket')).toBe(false);
    expect(stepWarning(state, 'scaleway-bucket')).toBe('policy could not be applied');

    const reloaded = loadState(dir, 'app');
    expect(isDone(reloaded, 'scaleway-bucket')).toBe(false);

    // The re-run succeeds cleanly: the warning is cleared and the step heals.
    markDone(dir, reloaded, 'scaleway-bucket');
    expect(isDone(loadState(dir, 'app'), 'scaleway-bucket')).toBe(true);
  });

  it('step data is preserved for later steps and kept alongside a warning', () => {
    dir = mkdtempSync(join(tmpdir(), 'keel-state-data-'));
    const state = loadState(dir, 'app');
    markDone(dir, state, 'infisical', { projectId: 'pid-1' });
    markDone(dir, state, 'github-config', undefined, 'branch protection needs a paid plan');
    const reloaded = loadState(dir, 'app');
    // The warned github-config step will re-run; the data it needs from the
    // clean infisical step must still be there.
    expect(reloaded.steps.infisical?.data?.projectId).toBe('pid-1');
    expect(isDone(reloaded, 'infisical')).toBe(true);
    expect(isDone(reloaded, 'github-config')).toBe(false);
  });

  it('state files from older versions (no warning field) still count as done', () => {
    dir = mkdtempSync(join(tmpdir(), 'keel-state-old-'));
    const state = loadState(dir, 'app');
    // Simulate an old-format entry: step recorded with an empty record.
    state.steps['github-push'] = {};
    expect(isDone(state, 'github-push')).toBe(true);
  });
});
