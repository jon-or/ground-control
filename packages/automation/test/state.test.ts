import { describe, expect, it } from 'vitest';
import { ACTION_REVISION, EMPTY_ACTIONS } from '@ground-control/core';
import type { ActionRun, ActionState, Lane, LanedCard, TriageQualifier } from '@ground-control/core';
import {
  ACTION_GATE_MS,
  BASE_BLOCK_MS,
  DISPATCH_WINDOW_MS,
  LINK_GRACE_MS,
  alreadyRun,
  baseKeyOf,
  cardActionOf,
  dispatchesInWindow,
  gateOpen,
  isBaseKey,
  mergeInto,
  nextActionState,
  readActionReport,
  readActionState,
  running,
  sessionLinks,
  withDispatch,
  worktreeCreationOf,
  withOutcome,
  withRefusal,
  withSession,
  withoutAbsentLinks,
} from '../src/state.js';
import type { CardReading } from '../src/state.js';

const NOW = Date.parse('2026-09-05T12:00:00Z');

function run(over: Partial<ActionRun> = {}): ActionRun {
  return {
    key: 'issue:17198',
    action: 'merge',
    qualifier: 'upstream',
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

/** A settled reading of the card, which is what a decorated card carries unless triage is mid-read. */
function reads(
  action: 'merge' | null,
  settled = true,
  at: number | null = NOW - 1,
  qualifier: TriageQualifier | null = action === null ? null : 'upstream',
): CardReading {
  return { action, qualifier, settled, at };
}

/** The row every merge·upstream reading names. */
const UPSTREAM = { action: 'merge', qualifier: 'upstream' } as const;

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
      links: { 'claude:a': { issueNumber: 7, at: 1 }, 'claude:b': { issueNumber: 'seven', at: 1 } },
    });

    expect(Object.keys(state.runs)).toEqual(['good']);
    expect(Object.keys(state.refusals)).toEqual(['r']);
    expect(state.gates).toEqual({ g: 5 });
    expect(state.dispatches).toEqual([1, 2]);
    expect(state.links).toEqual({ 'claude:a': { issueNumber: 7, at: 1 } });
  });

  it('takes a run written before the optional fields existed', () => {
    const stored = { runs: { a: { ...run(), endedAt: undefined, sessionId: undefined, detail: undefined } } };

    expect(readActionState(stored).runs['a']).toMatchObject({ endedAt: null, sessionId: null, detail: '' });
  });
});

describe('action reports', () => {
  it('reads a report a run wrote, and one in the earlier pushed wording', () => {
    expect(readActionReport({ outcome: 'done', detail: 'Merged master, 3 commits.' })).toEqual({
      outcome: 'done',
      detail: 'Merged master, 3 commits.',
    });
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

  // A worktree run reports where it made the worktree; the path is what the hub records (R46).
  it('reads a worktree report with its path, and rejects one naming no path worth recording', () => {
    expect(readActionReport({ outcome: 'ready', detail: 'Built.', worktree: 'd:/work/wt/refund' })).toEqual({
      outcome: 'ready',
      detail: 'Built.',
      worktree: 'd:/work/wt/refund',
    });
    expect(readActionReport({ outcome: 'ready', detail: 'Built.', worktree: '' })).toBe(null);
    expect(readActionReport({ outcome: 'ready', detail: 'Built.' })).toEqual({ outcome: 'ready', detail: 'Built.' });
  });
});

describe('repeat-run prevention', () => {
  it('blocks a second run against the same evidence, whatever the first one came to', () => {
    for (const outcome of ['landed', 'halted', 'stopped', 'running'] as const) {
      const state = { ...EMPTY_ACTIONS, runs: { 'issue:17198': run({ outcome }) } };

      expect(alreadyRun(state, 'issue:17198', '17198|4021|abc', 'merge', null)).toBe(true);
    }
  });

  /** Failed dispatch attempts may retry unchanged evidence; the read interval limits their frequency (R21). */
  it('does not block on a dispatch that never started', () => {
    const state = { ...EMPTY_ACTIONS, runs: { 'issue:17198': run({ outcome: 'failed' }) } };

    expect(alreadyRun(state, 'issue:17198', '17198|4021|abc', 'merge', null)).toBe(false);
  });

  it('does not block once the evidence has moved', () => {
    const state = { ...EMPTY_ACTIONS, runs: { 'issue:17198': run({ outcome: 'halted' }) } };

    expect(alreadyRun(state, 'issue:17198', '17198|4021|def', 'merge', null)).toBe(false);
  });

  // The follow-up would read the same head the initial review already read.
  it('blocks another qualifier of the same action on the same head, and not another action', () => {
    const review = { ...EMPTY_ACTIONS, runs: { 'issue:17198': run({ action: 'review-others', qualifier: 'initial', outcome: 'halted' }) } };

    expect(alreadyRun(review, 'issue:17198', '17198|4021|abc', 'review-others', null)).toBe(true);
    expect(alreadyRun(review, 'issue:17198', '17198|4021|abc', 'address-review', null)).toBe(false);
  });

  /** A successful merge blocks automatic repeats even when its own push changes headOid, until a new request. */
  it('blocks a run after one landed, however far the evidence has moved, until the card’s status changes', () => {
    const state = { ...EMPTY_ACTIONS, runs: { 'issue:17198': run({ outcome: 'landed', endedAt: NOW + 5 }) } };

    expect(alreadyRun(state, 'issue:17198', '17198|4021|the-commit-that-merge-pushed', 'merge', null)).toBe(true);
    expect(alreadyRun(state, 'issue:17198', '17198|4021|the-commit-that-merge-pushed', 'merge', NOW + 5)).toBe(true);
    expect(alreadyRun(state, 'issue:17198', '17198|4021|the-commit-that-merge-pushed', 'merge', NOW + 6)).toBe(false);
  });

  /** A tester's new report or question changes no commit, so it reopens a QA run that stopped short (R39). */
  // Both times are GitHub's, so a hub clock that differs from GitHub's neither repeats nor blocks a retry.
  it('allows a QA run again after a tester comment newer than the one it ran with, and only then', () => {
    const SEEN = NOW + 7_200_000;

    for (const action of ['qa-failure', 'qa-question'] as const) {
      const state = { ...EMPTY_ACTIONS, runs: { 'issue:17198': run({ action, evidence: '17198||', outcome: 'halted', startedAt: NOW, testerCommentAt: SEEN }) } };
      const none = { ...EMPTY_ACTIONS, runs: { 'issue:17198': run({ action, evidence: '17198||', outcome: 'halted', startedAt: NOW }) } };

      expect(alreadyRun(state, 'issue:17198', '17198||', action, null, null)).toBe(true);
      expect(alreadyRun(state, 'issue:17198', '17198||', action, null, SEEN)).toBe(true);
      expect(alreadyRun(state, 'issue:17198', '17198||', action, null, SEEN + 1)).toBe(false);
      expect(alreadyRun(none, 'issue:17198', '17198||', action, null, NOW - 1)).toBe(false);
    }

    // Other actions, a run still going, and a run that landed keep their own rules.
    const merge = { ...EMPTY_ACTIONS, runs: { 'issue:17198': run({ outcome: 'halted', startedAt: NOW }) } };
    const going = { ...EMPTY_ACTIONS, runs: { 'issue:17198': run({ action: 'qa-failure', evidence: '17198||', outcome: 'running', startedAt: NOW }) } };
    const landed = { ...EMPTY_ACTIONS, runs: { 'issue:17198': run({ action: 'qa-failure', evidence: '17198||', outcome: 'landed', startedAt: NOW, endedAt: NOW + 5 }) } };

    expect(alreadyRun(merge, 'issue:17198', '17198|4021|abc', 'merge', null, NOW + 1)).toBe(true);
    expect(alreadyRun(going, 'issue:17198', '17198||', 'qa-failure', null, NOW + 1)).toBe(true);
    expect(alreadyRun(landed, 'issue:17198', '17198||', 'qa-failure', null, NOW + 10)).toBe(true);
  });

  /** A merge that landed before the upgrade must still stop the same request merging again. */
  it('reads a record written before the table as the upstream merge it was', () => {
    const stored = { runs: { 'issue:17198': { ...run({ outcome: 'landed', endedAt: NOW }), action: 'merge-upstream', qualifier: undefined } } };
    const state = readActionState(stored);

    expect(state.runs['issue:17198']).toMatchObject({ action: 'merge', qualifier: 'upstream' });
    expect(alreadyRun(state, 'issue:17198', 'moved', 'merge', null)).toBe(true);
    expect(readActionState({ runs: { w: { ...run({ action: 'create-worktree' }), next: 'merge-upstream' } } }).runs['w']).toMatchObject({ next: 'merge', qualifier: 'upstream' });
  });

  /** So a gate that has since been corrected can reach the cards the broken one already spent. */
  it('does not block on a run recorded under an older revision', () => {
    const state = { ...EMPTY_ACTIONS, runs: { 'issue:17198': run({ revision: ACTION_REVISION - 1 }) } };

    expect(alreadyRun(state, 'issue:17198', '17198|4021|abc', 'merge', null)).toBe(false);
  });

  it('says nothing about a card it has never run', () => {
    expect(alreadyRun(EMPTY_ACTIONS, 'issue:1', 'anything', 'merge', null)).toBe(false);
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
    const state = withRefusal(EMPTY_ACTIONS, 'issue:17198', { kind: 'merge-type-changed', message: 'chain' }, NOW, UPSTREAM);

    expect(gateOpen(state, 'issue:17198', NOW)).toBe(false);
    expect(state.refusals['issue:17198']).toEqual({
      action: 'merge',
      qualifier: 'upstream',
      kind: 'merge-type-changed',
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
    const refused = withRefusal(EMPTY_ACTIONS, 'issue:17198', { kind: 'merge-type-changed', message: 'wait' }, NOW, UPSTREAM);
    const dispatched = withDispatch(refused, run(), NOW);

    expect(dispatched.refusals).toEqual({});
  });

  it('takes the session id once the roster carries it', () => {
    const state = withSession(withDispatch(EMPTY_ACTIONS, run(), NOW), 'issue:17198', 'dec295c0-5d29-4f82-aea3-f9', NOW);

    expect(state.runs['issue:17198']?.sessionId).toBe('dec295c0-5d29-4f82-aea3-f9');
  });

  it('links the session to the issue the run was dispatched for', () => {
    const state = withSession(withDispatch(EMPTY_ACTIONS, run({ issueNumber: 17198 }), NOW), 'issue:17198', 'dec295c0-5d29', NOW + 5);

    expect(state.links).toEqual({ 'claude:dec295c0-5d29': { issueNumber: 17198, at: NOW + 5 } });
    expect(sessionLinks(state)).toEqual(new Map([['claude:dec295c0-5d29', 17198]]));
  });

  it('links nothing for an older record with no issue', () => {
    const state = withSession(withDispatch(EMPTY_ACTIONS, run(), NOW), 'issue:17198', 'dec295c0-5d29', NOW);

    expect(state.links).toEqual({});
  });

  it('keeps a link after the card run that made it is replaced or pruned', () => {
    const linked = withSession(withDispatch(EMPTY_ACTIONS, run({ issueNumber: 17198 }), NOW), 'issue:17198', 'sid', NOW);
    const replaced = withDispatch(linked, run({ issueNumber: 17198, shortId: 'next' }), NOW + 1);
    const pruned = nextActionState([], withOutcome(replaced, 'issue:17198', 'landed', 'x', NOW + 2), true, NOW + 3);

    expect(pruned.runs).toEqual({});
    expect(pruned.links).toEqual(linked.links);
  });

  it('forgets a link only once its session is absent and the grace period has passed', () => {
    const state: ActionState = {
      ...EMPTY_ACTIONS,
      links: {
        'claude:present': { issueNumber: 1, at: NOW - LINK_GRACE_MS - 1 },
        'claude:recent': { issueNumber: 2, at: NOW - 1000 },
        'claude:gone': { issueNumber: 3, at: NOW - LINK_GRACE_MS - 1 },
      },
    };

    const next = withoutAbsentLinks(state, new Set(['claude:present']), NOW);

    expect(Object.keys(next.links)).toEqual(['claude:present', 'claude:recent']);
    expect(withoutAbsentLinks(next, new Set(['claude:present']), NOW)).toBe(next);
  });

  it('settles an outcome with the time it was settled', () => {
    const state = withOutcome(withDispatch(EMPTY_ACTIONS, run(), NOW), 'issue:17198', 'landed', 'Merged.', NOW + 60);

    expect(state.runs['issue:17198']).toMatchObject({ outcome: 'landed', detail: 'Merged.', endedAt: NOW + 60 });
  });

  it('leaves a key with no run exactly as it was', () => {
    expect(withOutcome(EMPTY_ACTIONS, 'issue:1', 'landed', 'x', NOW)).toBe(EMPTY_ACTIONS);
    expect(withSession(EMPTY_ACTIONS, 'issue:1', 'sid', NOW)).toBe(EMPTY_ACTIONS);
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
    expect(cardActionOf(EMPTY_ACTIONS, 'issue:1', reads(null), null)).toBeUndefined();
  });

  it('offers the control on a card the board could act on, whether or not the setting is on', () => {
    expect(cardActionOf(EMPTY_ACTIONS, 'issue:1', reads('merge'), null)).toEqual({
      state: 'available',
      action: 'merge',
      qualifier: 'upstream',
    });
  });

  it('says why the control would refuse before it is pressed', () => {
    expect(cardActionOf(EMPTY_ACTIONS, 'issue:1', reads('merge'), 'No prompt is set.')).toEqual({
      state: 'refused',
      action: 'merge',
      qualifier: 'upstream',
      reason: 'No prompt is set.',
    });
  });

  /** A refusal recorded from an earlier attempt may no longer hold, so a manual request can still be made over it. */
  it('says why the board declined, over the offer, and leaves it to be asked for', () => {
    const state = withRefusal(EMPTY_ACTIONS, 'issue:1', { kind: 'merge-type-changed', message: 'It is a chain.' }, NOW, UPSTREAM);

    expect(cardActionOf(state, 'issue:1', reads('merge'), null)).toEqual({
      state: 'refused',
      action: 'merge',
      qualifier: 'upstream',
      reason: 'It is a chain.',
      retryable: true,
    });
  });

  it('says why the control would refuse now, over why the board declined earlier', () => {
    const state = withRefusal(EMPTY_ACTIONS, 'issue:1', { kind: 'merge-type-changed', message: 'It is a chain.' }, NOW, UPSTREAM);

    expect(cardActionOf(state, 'issue:1', reads('merge'), 'This card has an active session.')).toEqual({
      state: 'refused',
      action: 'merge',
      qualifier: 'upstream',
      reason: 'This card has an active session.',
    });
  });

  /** A refusal describes the row it refused; a reading naming another row, or a refusal of no row, leaves the offer. */
  it('does not show a refusal of another row, or of none', () => {
    const refused = withRefusal(EMPTY_ACTIONS, 'issue:1', { kind: 'merge-type-changed', message: 'It is a chain.' }, NOW, UPSTREAM);
    const rowless = withRefusal(EMPTY_ACTIONS, 'issue:1', { kind: 'no-action', message: 'Nothing to run.' }, NOW);

    expect(cardActionOf(refused, 'issue:1', reads('merge', true, NOW - 1, 'stacked'), null)).toEqual({
      state: 'available',
      action: 'merge',
      qualifier: 'stacked',
    });
    expect(cardActionOf(rowless, 'issue:1', reads('merge'), null)).toEqual({ state: 'available', action: 'merge', qualifier: 'upstream' });
  });

  it('says a run is working, over everything else', () => {
    const state = withRefusal(withDispatch(EMPTY_ACTIONS, run(), NOW), 'issue:17198', { kind: 'k', message: 'm' }, NOW);

    expect(cardActionOf(state, 'issue:17198', reads('merge'), 'ignored')).toEqual({
      state: 'running',
      action: 'merge',
      qualifier: 'upstream',
      since: NOW,
    });
  });

  it('keeps a finished run on a card the next reading still reads the same way', () => {
    const state = withOutcome(withDispatch(EMPTY_ACTIONS, run(), NOW), 'issue:17198', 'halted', 'Conflicts.', NOW + 5);

    expect(cardActionOf(state, 'issue:17198', reads('merge'), null)).toEqual({
      state: 'done',
      action: 'merge',
      qualifier: 'upstream',
      outcome: 'halted',
      detail: 'Conflicts.',
      at: NOW + 5,
    });
  });

  /** A settled reading that names no action the board performs supersedes the run it no longer describes. */
  it('drops a finished run once the card reads as something else', () => {
    const state = withOutcome(withDispatch(EMPTY_ACTIONS, run(), NOW), 'issue:17198', 'halted', 'Conflicts.', NOW + 5);

    expect(cardActionOf(state, 'issue:17198', reads(null), null)).toBeUndefined();
    expect(cardActionOf(state, 'issue:17198', reads(null), 'No worktree.')).toBeUndefined();
  });

  /** A merge that landed reclassifies the card, and the outcome goes with the reading that replaced it. */
  it('drops a landed run the same way, rather than keeping a verdict the reading has moved past', () => {
    const state = withOutcome(withDispatch(EMPTY_ACTIONS, run(), NOW), 'issue:17198', 'landed', 'Merged master.', NOW + 5);

    expect(cardActionOf(state, 'issue:17198', reads(null), null)).toBeUndefined();
  });

  /**
   * The same reading taken again is a new one: it followed the run, so the run's verdict is no longer what the
   * card has to say. Reading again requires changed evidence, which is also what makes another run legitimate.
   */
  it('drops a finished run once the card has been read again, however that reading came out', () => {
    const state = withOutcome(withDispatch(EMPTY_ACTIONS, run(), NOW), 'issue:17198', 'halted', 'Conflicts.', NOW + 5);

    expect(cardActionOf(state, 'issue:17198', reads('merge', true, NOW + 6), null)).toEqual({
      state: 'available',
      action: 'merge',
      qualifier: 'upstream',
    });
    expect(cardActionOf(state, 'issue:17198', reads('merge', true, NOW + 4), null)).toMatchObject({ state: 'done' });
  });

  /** Reading again must not blink the outcome out: only a settled reading supersedes it. */
  it('keeps the outcome while the card is being read again, or its reading failed', () => {
    const state = withOutcome(withDispatch(EMPTY_ACTIONS, run(), NOW), 'issue:17198', 'halted', 'Conflicts.', NOW + 5);

    expect(cardActionOf(state, 'issue:17198', reads(null, false), null)).toMatchObject({
      state: 'done',
      action: 'merge',
      outcome: 'halted',
    });
  });

  // The worktree run before an action is that action's first stage; one asked for alone is not an action at all (R46).
  describe('while a worktree run is on the card', () => {
    const making = (next?: 'merge') =>
      withDispatch(
        EMPTY_ACTIONS,
        run({ action: 'create-worktree', ...(next === undefined ? { qualifier: null } : { next, qualifier: 'upstream' }) }),
        NOW,
      );

    it('shows the action it precedes as running, at its worktree stage', () => {
      expect(cardActionOf(making('merge'), 'issue:17198', reads('merge'), null)).toEqual({
        state: 'running',
        action: 'merge',
        qualifier: 'upstream',
        since: NOW,
        stage: 'worktree',
      });
    });

    it('leaves the action offerable while a worktree run asked for alone is running', () => {
      expect(cardActionOf(making(), 'issue:17198', reads('merge'), null)).toEqual({ state: 'available', action: 'merge', qualifier: 'upstream' });
      expect(cardActionOf(making(), 'issue:17198', reads(null), null)).toBeUndefined();
    });

    it('reports a worktree run that ended short of the action as that action, done', () => {
      const state = withOutcome(making('merge'), 'issue:17198', 'halted', 'No worktree reported.', NOW + 5);

      expect(cardActionOf(state, 'issue:17198', reads('merge'), null)).toEqual({
        state: 'done',
        action: 'merge',
        qualifier: 'upstream',
        outcome: 'halted',
        detail: 'No worktree reported.',
        at: NOW + 5,
      });
      // The action it stood for is the action the reading supersedes.
      expect(cardActionOf(state, 'issue:17198', reads(null), null)).toBeUndefined();
    });

    // The action's own record or refusal follows a linked run; showing the action as done would claim it ran.
    it('says nothing about a worktree run that linked its worktree, whatever it preceded', () => {
      const state = withOutcome(making('merge'), 'issue:17198', 'landed', 'Created d:/wt.', NOW + 5);

      expect(cardActionOf(state, 'issue:17198', reads('merge'), null)).toEqual({ state: 'available', action: 'merge', qualifier: 'upstream' });
      expect(cardActionOf(withRefusal(state, 'issue:17198', { kind: 'k', message: 'Draft.' }, NOW + 6, UPSTREAM), 'issue:17198', reads('merge'), null)).toEqual({
        state: 'refused',
        action: 'merge',
        qualifier: 'upstream',
        reason: 'Draft.',
        retryable: true,
      });
    });

    it('says nothing about a finished worktree run that preceded no action', () => {
      const state = withOutcome(making(), 'issue:17198', 'halted', 'No worktree reported.', NOW + 5);

      expect(cardActionOf(state, 'issue:17198', reads('merge'), null)).toEqual({ state: 'available', action: 'merge', qualifier: 'upstream' });
    });
  });
});

describe('what a card says about making its worktree', () => {
  const making = withDispatch(EMPTY_ACTIONS, run({ action: 'create-worktree', next: 'merge' }), NOW);

  it('offers to make one, or says why it cannot', () => {
    expect(worktreeCreationOf(EMPTY_ACTIONS, 'issue:17198', null)).toEqual({ state: 'available' });
    expect(worktreeCreationOf(EMPTY_ACTIONS, 'issue:17198', 'No prompt.')).toEqual({ state: 'refused', reason: 'No prompt.' });
  });

  it('shows the run making one, whether asked for alone or before an action', () => {
    expect(worktreeCreationOf(making, 'issue:17198', null)).toEqual({ state: 'running', since: NOW });
  });

  it('shows how the last run ended, over any refusal', () => {
    const state = withOutcome(making, 'issue:17198', 'halted', 'No worktree reported.', NOW + 5);

    expect(worktreeCreationOf(state, 'issue:17198', 'No prompt.')).toEqual({ state: 'done', outcome: 'halted', detail: 'No worktree reported.', at: NOW + 5 });
  });

  it('says nothing about an action run, which is not a worktree run', () => {
    expect(worktreeCreationOf(withDispatch(EMPTY_ACTIONS, run(), NOW), 'issue:17198', null)).toEqual({ state: 'available' });
  });
});

describe('what a worktree run leaves for the action after it', () => {
  it('never blocks the action: a worktree run has no PR evidence, whatever its outcome', () => {
    const linked = withOutcome(withDispatch(EMPTY_ACTIONS, run({ action: 'create-worktree', next: 'merge' }), NOW), 'issue:17198', 'landed', 'Created.', NOW + 5);

    expect(alreadyRun(linked, 'issue:17198', '17198|4021|abc', 'merge', null)).toBe(false);
    expect(alreadyRun(withOutcome(linked, 'issue:17198', 'halted', 'No worktree.', NOW + 5), 'issue:17198', '17198|4021|abc', 'merge', null)).toBe(false);
  });
});

describe('what a chained run costs', () => {
  it('counts the action after a worktree run as no new attempt', () => {
    const first = withDispatch(EMPTY_ACTIONS, run({ action: 'create-worktree', next: 'merge' }), NOW);
    const second = withDispatch(first, run(), NOW + 60_000, false);

    expect(second.dispatches).toEqual([NOW]);
    expect(second.runs['issue:17198']?.action).toBe('merge');
  });
});

/** A base merge is keyed by its branch, not a card, and shows on the card it was started for (R39). */
describe('a base merge and a merge being checked', () => {
  const BASE = 'merge:example-org/example-repo#17000-parent-feature';
  const leg = { repository: 'example-org/example-repo', source: 'master', sourceSha: 'd0d0d0d0', destination: '17000-parent-feature', target: '' };
  const baseRun = (over: Partial<ActionRun> = {}) =>
    run({ key: BASE, qualifier: 'base', issueNumber: 17000, merge: leg, for: { key: 'issue:17198', qualifier: 'stacked' }, ...over });
  const stackedReading = reads('merge', true, NOW - 1, 'stacked');

  it('keeps the merge, the check, and the card it is for through storage', () => {
    const stored = { ...EMPTY_ACTIONS, runs: { [BASE]: baseRun({ verifyingSince: NOW + 5 }) } };

    expect(readActionState(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it('names a base merge by its repository and branch, and finds the running merge into a branch', () => {
    const state = { ...EMPTY_ACTIONS, runs: { [BASE]: baseRun() } };

    expect(baseKeyOf('example-org/example-repo', '17000-parent-feature')).toBe(BASE);
    expect(isBaseKey(BASE)).toBe(true);
    expect(isBaseKey('issue:17198')).toBe(false);
    expect(mergeInto(state, 'example-org/example-repo', '17000-parent-feature')?.key).toBe(BASE);
    expect(mergeInto(state, 'example-org/example-repo', '17198-channel-mapping')).toBeUndefined();
    expect(mergeInto({ ...state, runs: { [BASE]: baseRun({ outcome: 'landed' }) } }, 'example-org/example-repo', '17000-parent-feature')).toBeUndefined();
  });

  it('shows a running base merge on its card as the card\'s merge at the base stage', () => {
    const state = { ...EMPTY_ACTIONS, runs: { [BASE]: baseRun() } };

    expect(cardActionOf(state, 'issue:17198', stackedReading, null)).toEqual({
      state: 'running',
      action: 'merge',
      qualifier: 'stacked',
      since: NOW,
      stage: 'base',
      detail: 'Merging master into 17000-parent-feature first.',
    });
  });

  it('shows a halted base merge on its card, naming the base, over the card\'s older run', () => {
    const state = {
      ...EMPTY_ACTIONS,
      runs: {
        'issue:17198': run({ outcome: 'landed', startedAt: NOW - 10_000, endedAt: NOW - 9_000 }),
        [BASE]: baseRun({ outcome: 'halted', endedAt: NOW + 10, detail: 'Conflicts.' }),
      },
    };

    expect(cardActionOf(state, 'issue:17198', stackedReading, null)).toMatchObject({
      state: 'done',
      qualifier: 'stacked',
      outcome: 'halted',
      detail: '17000-parent-feature: Conflicts.',
    });
  });

  it('shows the card\'s own merge once the base merge landed', () => {
    const state = {
      ...EMPTY_ACTIONS,
      runs: {
        [BASE]: baseRun({ outcome: 'landed', endedAt: NOW + 10 }),
        'issue:17198': run({ qualifier: 'stacked', startedAt: NOW + 20 }),
      },
    };

    expect(cardActionOf(state, 'issue:17198', stackedReading, null)).toEqual({ state: 'running', action: 'merge', qualifier: 'stacked', since: NOW + 20 });
  });

  it('shows a merge whose push is being checked at the verifying stage', () => {
    const state = { ...EMPTY_ACTIONS, runs: { 'issue:17198': run({ merge: { ...leg, destination: '17198-channel-mapping' }, verifyingSince: NOW + 5 }) } };

    expect(cardActionOf(state, 'issue:17198', reads('merge'), null)).toMatchObject({ state: 'running', stage: 'verifying' });
  });

  /** No card has a base merge's key; a landed one has nothing left to block, a halted one blocks its tips. */
  it('keeps a landed base merge a day and one that did not land for BASE_BLOCK_MS, then drops them', () => {
    const landed = { ...EMPTY_ACTIONS, runs: { [BASE]: baseRun({ outcome: 'landed', endedAt: NOW }) } };
    const halted = { ...EMPTY_ACTIONS, runs: { [BASE]: baseRun({ outcome: 'halted', endedAt: NOW }) } };
    const at = (state: ActionState, now: number) => nextActionState(laneWith('issue:17198'), state, true, now).runs[BASE];

    expect(at(landed, NOW + 1_000)).toBeDefined();
    expect(at(landed, NOW + DISPATCH_WINDOW_MS)).toBeUndefined();
    expect(at(halted, NOW + DISPATCH_WINDOW_MS)).toBeDefined();
    expect(at(halted, NOW + BASE_BLOCK_MS)).toBeUndefined();
  });

  it('keeps the merge and the card it is for through a dispatch and a pass', () => {
    const dispatched = withDispatch(EMPTY_ACTIONS, baseRun(), NOW);

    expect(dispatched.runs[BASE]).toEqual(baseRun());
    expect(nextActionState(laneWith('issue:17198'), dispatched, true, NOW + 1).runs[BASE]).toEqual(baseRun());
  });
});

describe('a run’s report (R51)', () => {
  const REPORT = 'D:/git/orez/.wip/review-pr/round-1/review.md';

  it('keeps an absolute report path with the outcome, and none for a relative one', () => {
    const started = withDispatch(EMPTY_ACTIONS, run(), NOW);

    expect(withOutcome(started, 'issue:17198', 'landed', 'Reviewed.', NOW + 60, REPORT).runs['issue:17198']?.auditPath).toBe(REPORT);
    expect(withOutcome(started, 'issue:17198', 'halted', 'Stopped at the gate.', NOW + 60, REPORT).runs['issue:17198']?.auditPath).toBe(REPORT);
    expect(withOutcome(started, 'issue:17198', 'landed', 'Reviewed.', NOW + 60, '.wip/review.md').runs['issue:17198']).not.toHaveProperty('auditPath');
  });

  it('drops an earlier outcome’s report when a later one names none', () => {
    const reported = withOutcome(withDispatch(EMPTY_ACTIONS, run(), NOW), 'issue:17198', 'halted', 'Gate.', NOW + 60, REPORT);

    expect(withOutcome(reported, 'issue:17198', 'landed', 'Published.', NOW + 120).runs['issue:17198']).not.toHaveProperty('auditPath');
  });

  it('gives a finished run with a report the id its history entry goes by', () => {
    const state = withOutcome(withDispatch(EMPTY_ACTIONS, run(), NOW), 'issue:17198', 'landed', 'Merged.', NOW + 60, REPORT);
    const plain = withOutcome(withDispatch(EMPTY_ACTIONS, run(), NOW), 'issue:17198', 'landed', 'Merged.', NOW + 60);

    expect(cardActionOf(state, 'issue:17198', reads('merge', false), null)).toMatchObject({ state: 'done', reportId: `issue:17198@${NOW}` });
    expect(cardActionOf(plain, 'issue:17198', reads('merge', false), null)).not.toHaveProperty('reportId');
  });

  it('reads an older record with no report, and drops a malformed one', () => {
    expect(readActionState({ runs: { 'issue:17198': run() } })?.runs['issue:17198']).not.toHaveProperty('auditPath');
    expect(readActionState({ runs: { 'issue:17198': { ...run(), auditPath: 7 } } })?.runs['issue:17198']?.action).toBe('merge');
  });
});
