import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { TRIAGE_REVISION, withTriageFailure } from '@ground-control/board';
import type { TriageState } from '@ground-control/core';
import { makeTriageStore } from '../src/triageStore.js';
import { triagePathOf } from '../src/paths.js';
import { tempHome } from './helpers.js';

let home: string;
let dispose: () => void;

beforeEach(() => {
  ({ home, dispose } = tempHome());
});

afterEach(() => dispose());

describe('what the board remembers about each card', () => {
  it('returns empty state for a missing file', () => {
    expect(makeTriageStore(home).read()).toEqual({ entries: {}, failures: {} });
  });

  it('round-trips exhausted retry state', () => {
    // Encode exhausted-retry Infinity as a finite timestamp; JSON null would invalidate the failure and permit retries.
    const store = makeTriageStore(home);
    let state: TriageState = { entries: {}, failures: {} };

    for (let attempt = 0; attempt < 5; attempt++) {
      state = withTriageFailure(state, 'issue:1', { kind: 'classify-missing', message: 'no' }, 0);
    }

    expect(state.failures['issue:1']?.nextAt).toBe(Number.POSITIVE_INFINITY);
    expect(store.write(state)).toBe(true);
    expect(readFileSync(triagePathOf(home), 'utf8')).not.toContain('null');

    const back = store.read().failures['issue:1'];

    expect(back?.attempts).toBe(5);
    expect(back?.nextAt).toBeGreaterThan(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
  });

  it('reads a hand-edited file, so an edit is not silently overwritten by the next reading', () => {
    const store = makeTriageStore(home);
    store.write({ entries: {}, failures: {} });
    writeFileSync(
      triagePathOf(home),
      JSON.stringify({ entries: { 'issue:9': { revision: TRIAGE_REVISION, action: 'merge-upstream', qualifier: null, detail: 'go', at: 1, agent: 'claude', wasArchived: false, evidence: 'e' } }, failures: {} }),
    );

    expect(store.read().entries['issue:9']?.action).toBe('merge-upstream');
  });

  it('returns empty state for invalid JSON', () => {
    makeTriageStore(home).write({ entries: {}, failures: {} });
    writeFileSync(triagePathOf(home), 'not json');

    expect(makeTriageStore(home).read()).toEqual({ entries: {}, failures: {} });
  });

  it('reports persistence failure', () => {
    // A directory where the file belongs is the shape of every persistent write failure: a read-only home, an ACL.
    const store = makeTriageStore(`${home}/nowhere/\u0000`);

    expect(store.write({ entries: {}, failures: {} })).toBe(false);
  });
});
