import { describe, expect, it } from 'vitest';
import type { ActionRun, ActionState } from '@ground-control/core';
import { HISTORY_LIMIT, HISTORY_RETENTION_MS, historyWith, readActionHistory } from '../src/history.js';

const NOW = 1_790_000_000_000;

function run(over: Partial<ActionRun> = {}): ActionRun {
  return {
    key: 'issue:17198',
    action: 'develop',
    qualifier: null,
    issueNumber: 17198,
    trigger: 'editor',
    revision: 2,
    evidence: '17198||',
    startedAt: NOW - 60_000,
    endedAt: null,
    agent: 'claude',
    sessionId: null,
    shortId: '5a94b51f',
    outcome: 'running',
    detail: 'Working in D:/git/orez.worktrees/17198-x.',
    ...over,
  };
}

function state(runs: Record<string, ActionRun>): ActionState {
  return { runs, refusals: {}, gates: {}, dispatches: [], links: {} };
}

describe('the action history (R50)', () => {
  it('adds a new run, then takes its outcome, keeping the trigger', () => {
    const started = historyWith([], state({ 'issue:17198': run() }), NOW);
    const ended = historyWith(started, state({ 'issue:17198': run({ outcome: 'landed', endedAt: NOW, detail: 'Ready for review.' }) }), NOW);

    expect(started).toHaveLength(1);
    expect(ended).toEqual([{
      id: `issue:17198@${NOW - 60_000}`,
      key: 'issue:17198',
      issueNumber: 17198,
      action: 'develop',
      qualifier: null,
      trigger: 'editor',
      agent: 'claude',
      startedAt: NOW - 60_000,
      endedAt: NOW,
      outcome: 'landed',
      detail: 'Ready for review.',
    }]);
  });

  it('keeps a replaced run as it last was, lists a base merge under the card it was for, and orders by start', () => {
    const first = historyWith([], state({ 'issue:17198': run({ action: 'create-worktree', next: 'develop', outcome: 'landed', endedAt: NOW - 30_000 }) }), NOW);
    const both = historyWith(first, state({
      'issue:17198': run({ startedAt: NOW - 20_000, trigger: 'automatic' }),
      'merge:o/r#base': run({ key: 'merge:o/r#base', action: 'merge', qualifier: 'base', startedAt: NOW - 25_000, for: { key: 'issue:17198', qualifier: 'stacked' } }),
    }), NOW);

    expect(both.map((one) => [one.action, one.key, one.outcome, one.trigger])).toEqual([
      ['create-worktree', 'issue:17198', 'landed', 'editor'],
      ['merge', 'issue:17198', 'running', 'editor'],
      ['develop', 'issue:17198', 'running', 'automatic'],
    ]);
    expect(both[0]!.next).toBe('develop');
  });

  it('drops entries past the retention window, then the oldest past the limit', () => {
    const old = historyWith([], state({ a: run({ startedAt: NOW - HISTORY_RETENTION_MS }) }), NOW);

    expect(old).toEqual([]);

    let many = historyWith([], state({}), NOW);

    for (let at = 0; at < HISTORY_LIMIT + 3; at++) {
      many = historyWith(many, state({ 'issue:1': run({ startedAt: NOW - 1_000_000 + at }) }), NOW);
    }

    expect(many).toHaveLength(HISTORY_LIMIT);
    expect(many[0]!.startedAt).toBe(NOW - 1_000_000 + 3);
  });

  it('reads stored entries one by one, and nothing from a wrong shape', () => {
    const good = historyWith([], state({ 'issue:17198': run() }), NOW)[0];

    expect(readActionHistory({ entries: [good, { id: 'x' }, 'bad'] })).toEqual([good]);
    expect(readActionHistory([good])).toEqual([]);
  });
});
