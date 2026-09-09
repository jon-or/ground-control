import { describe, expect, it } from 'vitest';
import { ACTION_REVISION, EMPTY_ACTIONS } from '@ground-control/core';
import type { ActionRun, ActionState, Lane, LanedCard } from '@ground-control/core';
import {
  ACTION_GATE_MS,
  DISPATCH_WINDOW_MS,
  alreadyRun,
  cardActionOf,
  dispatchesInWindow,
  gateOpen,
  nextActionState,
  readActionReport,
  readActionState,
  running,
  withDispatch,
  withOutcome,
  withRefusal,
  withSession,
} from '../src/state.js';

const NOW = Date.parse('2026-09-05T12:00:00Z');

function run(over: Partial<ActionRun> = {}): ActionRun {
  return {
    key: 'issue:17198',
    action: 'merge-upstream',
    revision: ACTION_REVISION,
    evidence: '17198|4021|abc',
    startedAt: NOW,
    endedAt: null,
    agent: 'claude',
    sessionId: null,
    shortId: 'dec295c0',
    outcome: 'running',
    detail: 'Working in d:/work/repo.',
    ...over,
  };
}

function laneWith(...keys: string[]): Lane[] {
  return [
    {
      id: 'review',
      title: 'Review',
      cards: keys.map(
        (key): LanedCard => ({
          key,
          issue: null,
          issueNumber: null,
          sessions: [],
          lane: 'review',
          returned: false,
          attention: null,
          reason: '',
        }),
      ),
    },
  ];
}

describe('reading what is stored', () => {
  it('reads an empty state from anything that is not one', () => {
    expect(readActionState(null)).toEqual(EMPTY_ACTIONS);
    expect(readActionState('nonsense')).toEqual(EMPTY_ACTIONS);
    expect(readActionState(42)).toEqual(EMPTY_ACTIONS);
  });

  /** Discard invalid records individually to preserve other cards and limits. */
  it('drops one unreadable run and keeps the rest', () => {
    const state = readActionState({
      // Discard run records naming unsupported actions.
      runs: { good: run(), bad: { key: 'bad' }, wrongAction: { ...run(), action: 'land' } },
      refusals: {
        r: { kind: 'k', message: 'm', at: 1, revision: ACTION_REVISION },
        broken: { kind: 'k' },
        // Discard refusals from older revisions, including disabled actions.
        stale: { kind: 'not-computed', message: 'wait', at: 1, revision: ACTION_REVISION - 1 },
      },
      gates: { g: 5, notANumber: 'x' },
      dispatches: [1, 2, Number.POSITIVE_INFINITY],
    });

    expect(Object.keys(state.runs)).toEqual(['good']);
    expect(Object.keys(state.refusals)).toEqual(['r']);
    expect(state.gates).toEqual({ g: 5 });
    expect(state.dispatches).toEqual([1, 2]);
  });

  it('takes a run written before the optional fields existed', () => {
    const stored = { runs: { a: { ...run(), endedAt: undefined, sessionId: undefined, detail: undefined } } };

    expect(readActionState(stored).runs['a']).toMatchObject({ endedAt: null, sessionId: null, detail: '' });
  });
});

describe('action reports', () => {
  it('reads a report a run wrote', () => {
    expect(readActionReport({ outcome: 'pushed', detail: 'Merged master, 3 commits.' })).toEqual({
      outcome: 'pushed',
      detail: 'Merged master, 3 commits.',
    });
  });

  it('rejects unknown outcomes and empty explanations', () => {
    expect(readActionReport({ outcome: 'landed', detail: 'x' })).toBe(null);
    expect(readActionReport({ outcome: 'pushed', detail: '' })).toBe(null);
    expect(readActionReport(null)).toBe(null);
  });
});

describe('repeat-run prevention', () => {
  it('blocks a second run against the same evidence, whatever the first one came to', () => {
    for (const outcome of ['landed', 'halted', 'stopped', 'running'] as const) {
      const state = { ...EMPTY_ACTIONS, runs: { 'issue:17198': run({ outcome }) } };

      expect(alreadyRun(state, 'issue:17198', '17198|4021|abc')).toBe(true);
    }
  });

  /** Failed dispatch attempts may retry unchanged evidence; the read interval limits their frequency (R21). */
  it('does not block on a dispatch that never started', () => {
    const state = { ...EMPTY_ACTIONS, runs: { 'issue:17198': run({ outcome: 'failed' }) } };

    expect(alreadyRun(state, 'issue:17198', '17198|4021|abc')).toBe(false);
  });

  it('does not block once the evidence has moved', () => {
    const state = { ...EMPTY_ACTIONS, runs: { 'issue:17198': run({ outcome: 'halted' }) } };

    expect(alreadyRun(state, 'issue:17198', '17198|4021|def')).toBe(false);
  });

  /** A successful merge blocks automatic repeats even when its own push changes headOid. */
  it('blocks a run after one landed, however far the evidence has moved since', () => {
    const state = { ...EMPTY_ACTIONS, runs: { 'issue:17198': run({ outcome: 'landed' }) } };

    expect(alreadyRun(state, 'issue:17198', '17198|4021|the-commit-that-merge-pushed')).toBe(true);
  });

  /** So a gate that has since been corrected can reach the cards the broken one already spent. */
  it('does not block on a run recorded under an older revision', () => {
    const state = { ...EMPTY_ACTIONS, runs: { 'issue:17198': run({ revision: ACTION_REVISION - 1 }) } };

    expect(alreadyRun(state, 'issue:17198', '17198|4021|abc')).toBe(false);
  });

  it('says nothing about a card it has never run', () => {
    expect(alreadyRun(EMPTY_ACTIONS, 'issue:1', 'anything')).toBe(false);
    expect(running(EMPTY_ACTIONS, 'issue:1')).toBe(false);
  });
});

describe('the read gate', () => {
  it('is open for a card the board has never answered for', () => {
    expect(gateOpen(EMPTY_ACTIONS, 'issue:17198', NOW)).toBe(true);
  });

  it('closes for the gate window after a dispatch, and opens again once it lapses', () => {
    const state = withDispatch(EMPTY_ACTIONS, run(), NOW);

    expect(gateOpen(state, 'issue:17198', NOW)).toBe(false);
    expect(gateOpen(state, 'issue:17198', NOW + ACTION_GATE_MS - 1)).toBe(false);
    expect(gateOpen(state, 'issue:17198', NOW + ACTION_GATE_MS)).toBe(true);
  });

  it('closes after a refusal too, so the same read is not made on every pass', () => {
    const state = withRefusal(EMPTY_ACTIONS, 'issue:17198', { kind: 'stacked-branch', message: 'chain' }, NOW);

    expect(gateOpen(state, 'issue:17198', NOW)).toBe(false);
    expect(state.refusals['issue:17198']).toEqual({
      kind: 'stacked-branch',
      message: 'chain',
      at: NOW,
      revision: ACTION_REVISION,
    });
  });
});

describe('the daily ceiling', () => {
  it('counts only the dispatches inside the rolling day', () => {
    const state: ActionState = { ...EMPTY_ACTIONS, dispatches: [NOW - DISPATCH_WINDOW_MS - 1, NOW - 1000, NOW] };

    expect(dispatchesInWindow(state, NOW)).toBe(2);
  });

  it('records a dispatch and drops the ones that have aged out', () => {
    const state = withDispatch({ ...EMPTY_ACTIONS, dispatches: [NOW - DISPATCH_WINDOW_MS - 1] }, run(), NOW);

    expect(state.dispatches).toEqual([NOW]);
  });

  /** A dispatch that failed still spent an attempt, so it counts: the ceiling bounds tries, not successes. */
  it('counts a dispatch that failed, because starting one is the cost', () => {
    const state = withDispatch(EMPTY_ACTIONS, run({ outcome: 'failed' }), NOW);

    expect(dispatchesInWindow(state, NOW)).toBe(1);
  });
});

describe('following a run', () => {
  it('clears an earlier refusal when the card is dispatched for', () => {
    const refused = withRefusal(EMPTY_ACTIONS, 'issue:17198', { kind: 'stacked-branch', message: 'wait' }, NOW);
    const dispatched = withDispatch(refused, run(), NOW);

    expect(dispatched.refusals).toEqual({});
  });

  it('takes the session id once the roster carries it', () => {
    const state = withSession(withDispatch(EMPTY_ACTIONS, run(), NOW), 'issue:17198', 'dec295c0-5d29-4f82-aea3-f9');

    expect(state.runs['issue:17198']?.sessionId).toBe('dec295c0-5d29-4f82-aea3-f9');
  });

  it('settles an outcome with the time it was settled', () => {
    const state = withOutcome(withDispatch(EMPTY_ACTIONS, run(), NOW), 'issue:17198', 'landed', 'Merged.', NOW + 60);

    expect(state.runs['issue:17198']).toMatchObject({ outcome: 'landed', detail: 'Merged.', endedAt: NOW + 60 });
  });

  it('leaves a key with no run exactly as it was', () => {
    expect(withOutcome(EMPTY_ACTIONS, 'issue:1', 'landed', 'x', NOW)).toBe(EMPTY_ACTIONS);
    expect(withSession(EMPTY_ACTIONS, 'issue:1', 'sid')).toBe(EMPTY_ACTIONS);
  });
});

describe('what a render leaves behind', () => {
  it('drops everything about a card that has left the board', () => {
    const dispatched = withDispatch(EMPTY_ACTIONS, run({ outcome: 'landed' }), NOW);
    const refused = withRefusal(dispatched, 'issue:99', { kind: 'k', message: 'm' }, NOW);
    const next = nextActionState(laneWith('issue:99'), refused, true, NOW);

    expect(Object.keys(next.runs)).toEqual([]);
    expect(Object.keys(next.refusals)).toEqual(['issue:99']);
    expect(Object.keys(next.gates)).toEqual(['issue:99']);
  });

  /** Retain running actions for absent cards so stop and completion tracking remain available. */
  it('keeps a run still working, even for a card that has left the board', () => {
    const dispatched = withDispatch(EMPTY_ACTIONS, run({ outcome: 'running' }), NOW);
    const next = nextActionState(laneWith('issue:99'), dispatched, true, NOW);

    expect(Object.keys(next.runs)).toEqual(['issue:17198']);
    // Its gate goes with the card, which is right: nothing will be dispatched for a card that is not on the board.
    expect(Object.keys(next.gates)).toEqual([]);
  });

  /** A failed source read re-renders the last good cards, so absence there proves nothing about a card. */
  it('drops nothing when the sources could not be read', () => {
    const dispatched = withDispatch(EMPTY_ACTIONS, run(), NOW);
    const next = nextActionState(laneWith(), dispatched, false, NOW);

    expect(Object.keys(next.runs)).toEqual(['issue:17198']);
  });

  it('ages out dispatch timestamps whether or not the sources were read', () => {
    const stale: ActionState = { ...EMPTY_ACTIONS, dispatches: [NOW - DISPATCH_WINDOW_MS - 1, NOW] };

    expect(nextActionState(laneWith(), stale, false, NOW).dispatches).toEqual([NOW]);
    expect(nextActionState(laneWith(), stale, true, NOW).dispatches).toEqual([NOW]);
  });
});

describe('what a card says about its action', () => {
  it('says nothing where the card reading is not one the board performs', () => {
    expect(cardActionOf(EMPTY_ACTIONS, 'issue:1', null, null)).toBeUndefined();
  });

  it('offers the control on a card the board could act on, whether or not the setting is on', () => {
    expect(cardActionOf(EMPTY_ACTIONS, 'issue:1', 'merge-upstream', null)).toEqual({
      state: 'available',
      action: 'merge-upstream',
    });
  });

  it('says why the control would refuse before it is pressed', () => {
    expect(cardActionOf(EMPTY_ACTIONS, 'issue:1', 'merge-upstream', 'No prompt is set.')).toEqual({
      state: 'refused',
      action: 'merge-upstream',
      reason: 'No prompt is set.',
    });
  });

  it('says why the board declined, over the offer', () => {
    const state = withRefusal(EMPTY_ACTIONS, 'issue:1', { kind: 'stacked-branch', message: 'It is a chain.' }, NOW);

    expect(cardActionOf(state, 'issue:1', 'merge-upstream', null)).toEqual({
      state: 'refused',
      action: 'merge-upstream',
      reason: 'It is a chain.',
    });
  });

  it('says a run is working, over everything else', () => {
    const state = withRefusal(withDispatch(EMPTY_ACTIONS, run(), NOW), 'issue:17198', { kind: 'k', message: 'm' }, NOW);

    expect(cardActionOf(state, 'issue:17198', 'merge-upstream', 'ignored')).toEqual({
      state: 'running',
      action: 'merge-upstream',
      since: NOW,
    });
  });

  /** The action a finished run reports is the one it ran, not whatever the card has since been triaged to. */
  it('reports a finished run by what it did, whatever the card now reads as', () => {
    const state = withOutcome(withDispatch(EMPTY_ACTIONS, run(), NOW), 'issue:17198', 'halted', 'Conflicts.', NOW + 5);

    expect(cardActionOf(state, 'issue:17198', null, null)).toEqual({
      state: 'done',
      action: 'merge-upstream',
      outcome: 'halted',
      detail: 'Conflicts.',
      at: NOW + 5,
    });
  });
});
