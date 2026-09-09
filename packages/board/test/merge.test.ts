import { describe, expect, it } from 'vitest';
import { mergeBoard } from '../src/index.js';
import type { Session } from '../src/types.js';
import { checkoutKeyOf, issues, linkedOffBoard, linkedOnBoard, offBoardIssues, onBoard, sessions, unlinked, unlinkedCheckouts } from './helpers.js';

const board = mergeBoard(issues, sessions, [], offBoardIssues);

describe('the recording these tests rest on', () => {
  it('covers all three ways a session reaches the board', () => {
    expect(linkedOnBoard.length).toBeGreaterThan(0);
    expect(linkedOffBoard.length).toBeGreaterThan(0);
    expect(unlinked.length).toBeGreaterThan(0);
  });

  it('covers two checkouts of issue-less work, one of them holding several sessions', () => {
    expect(unlinkedCheckouts.size).toBeGreaterThan(1);
    expect(unlinked.length).toBeGreaterThan(unlinkedCheckouts.size);
  });

  it('covers an issue card holding more than one session', () => {
    const counts = new Map<number, number>();

    for (const session of linkedOnBoard) {
      counts.set(session.issueNumber!, (counts.get(session.issueNumber!) ?? 0) + 1);
    }

    expect([...counts.values()].filter((n) => n > 1).length).toBeGreaterThan(0);
  });

  it('covers an issue with no session at all', () => {
    const withSessions = new Set(linkedOnBoard.map((s) => s.issueNumber));

    expect(issues.filter((issue) => !withSessions.has(issue.number)).length).toBeGreaterThan(0);
  });
});

describe('mergeBoard', () => {
  it('puts every session on exactly one card — R2 allows none to be invisible', () => {
    const placed = board.flatMap((card) => card.sessions.map((s) => s.sessionId));

    expect(placed).toHaveLength(sessions.length);
    expect(new Set(placed).size).toBe(sessions.length);
    expect(new Set(placed)).toEqual(new Set(sessions.map((s) => s.sessionId)));
  });

  it('gives every issue a card, in the order they were read', () => {
    expect(board.slice(0, issues.length).map((card) => card.issue?.number)).toEqual(issues.map((i) => i.number));
  });

  it('gives every card a unique key', () => {
    expect(new Set(board.map((card) => card.key)).size).toBe(board.length);
  });

  it('nests a session under its issue card', () => {
    const session = linkedOnBoard[0]!;
    const card = board.find((c) => c.issue?.number === session.issueNumber);

    expect(card?.sessions.map((s) => s.sessionId)).toContain(session.sessionId);
  });

  it('holds several sessions on one issue card, newest started first', () => {
    const busiest = board
      .filter((card) => card.sessions.length > 1)
      .sort((a, b) => b.sessions.length - a.sessions.length)[0];

    expect(busiest).toBeDefined();
    expect(busiest!.sessions.map((s) => s.startedAt)).toEqual(
      [...busiest!.sessions.map((s) => s.startedAt)].sort((a, b) => b - a),
    );
  });

  it('leaves an issue with no session an empty card rather than dropping it', () => {
    const withSessions = new Set(linkedOnBoard.map((s) => s.issueNumber));
    const bare = issues.find((issue) => !withSessions.has(issue.number))!;

    expect(board.find((card) => card.issue?.number === bare.number)?.sessions).toEqual([]);
  });

  it('names the issue on a card for a session whose issue is not the developer own', () => {
    const off = linkedOffBoard[0]!;
    const card = board.find((c) => c.issueNumber === off.issueNumber);

    expect(card?.issue).toEqual(offBoardIssues.get(off.issueNumber!));
    expect(card?.unassigned).toBe(true);
    expect(card?.sessions.map((s) => s.sessionId)).toContain(off.sessionId);
    expect(onBoard.has(off.issueNumber!)).toBe(false);
  });

  it('leaves an assigned card unmarked, so the lanes tell one apart from an issue nobody gave the developer', () => {
    expect(board.find((c) => onBoard.has(c.issueNumber ?? -1))?.unassigned).toBeUndefined();
  });

  it('drops a number nothing could be looked up for, so the session joins its checkout rather than a bare card', () => {
    const off = linkedOffBoard[0]!;
    const cards = mergeBoard([], [off]);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.issueNumber).toBeNull();
    expect(cards[0]?.key).toBe(`session:${checkoutKeyOf(off)}`);
    expect(cards[0]?.sessions.map((s) => s.sessionId)).toEqual([off.sessionId]);
  });

  it('gives each checkout of issue-less work one card, holding every session running there', () => {
    const cards = board.filter((c) => c.issueNumber === null);

    expect(cards).toHaveLength(unlinkedCheckouts.size);

    for (const card of cards) {
      const key = checkoutKeyOf(card.sessions[0]!);
      const running = unlinked.filter((s) => checkoutKeyOf(s) === key);

      expect(card.issue).toBeNull();
      expect(card.key).toBe(`session:${key}`);
      expect(card.sessions).toHaveLength(running.length);
      expect(card.sessions.map((s) => s.startedAt)).toEqual([...running.map((s) => s.startedAt)].sort((a, b) => b - a));
    }
  });

  it('orders the board as issues, then issues the developer does not own, then sessions alone', () => {
    const offBoardNumbers = new Set(linkedOffBoard.map((s) => s.issueNumber));

    expect(board).toHaveLength(issues.length + offBoardNumbers.size + unlinkedCheckouts.size);
    expect(board.slice(issues.length, issues.length + offBoardNumbers.size).every((c) => c.issueNumber !== null)).toBe(
      true,
    );
    expect(board.slice(issues.length + offBoardNumbers.size).every((c) => c.issueNumber === null)).toBe(true);
  });

  it('is an empty board when the machine is idle and nothing is assigned', () => {
    expect(mergeBoard([], [])).toEqual([]);
  });

  it('shows only issues when no session is running', () => {
    expect(mergeBoard(issues, []).every((card) => card.sessions.length === 0)).toBe(true);
  });

  it('shows only sessions when nothing is assigned', () => {
    const cards = mergeBoard([], sessions);

    expect(cards.flatMap((c) => c.sessions)).toHaveLength(sessions.length);
    expect(cards.every((card) => card.issue === null)).toBe(true);
  });

  it('groups two sessions that name the same absent issue onto one card', () => {
    const off = linkedOffBoard[0]!;
    const twin: Session = { ...off, sessionId: `${off.sessionId}-twin`, startedAt: off.startedAt + 1000 };
    const cards = mergeBoard([], [off, twin], [], offBoardIssues);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.sessions.map((s) => s.sessionId)).toEqual([twin.sessionId, off.sessionId]);
  });

  it('puts two agents in one checkout on one card — the checkout is the work, not the CLI', () => {
    const mine = unlinked[0]!;
    const twin: Session = { ...mine, agent: 'other-cli', startedAt: mine.startedAt + 1000 };
    const cards = mergeBoard([], [mine, twin]);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.sessions.map((s) => s.agent)).toEqual(['other-cli', mine.agent]);
  });

  it('puts a session started below the checkout on the card the checkout already has', () => {
    const mine = unlinked[0]!;
    const below: Session = { ...mine, sessionId: 'below', cwd: `${mine.cwd}/packages/core` };
    const cards = mergeBoard([], [mine, below]);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.sessions).toHaveLength(2);
  });

  it('gives each branch of one repository a card of its own, so a worktree is never folded into the clone', () => {
    const mine = unlinked[0]!;
    const worktree: Session = {
      ...mine,
      sessionId: 'worktree',
      cwd: `${mine.cwd}/.worktrees/spike`,
      checkoutRoot: `${mine.cwd}/.worktrees/spike`,
      branch: 'spike',
    };

    expect(mergeBoard([], [mine, worktree]).map((c) => c.key)).toEqual([
      `session:${mine.repository}#${mine.branch}`,
      `session:${mine.repository}#spike`,
    ]);
  });

  it('falls back to the checkout directory where git names no repository, past separators and case', () => {
    const below = `${unlinked[0]!.checkoutRoot}/packages/core`;
    const mine: Session = { ...unlinked[0]!, repository: null, cwd: below };
    const variants: Session[] = [
      mine,
      { ...mine, sessionId: 'trailing', checkoutRoot: `${mine.checkoutRoot}/` },
      { ...mine, sessionId: 'backslash', checkoutRoot: mine.checkoutRoot!.split('/').join('\\') },
      { ...mine, sessionId: 'upper', checkoutRoot: mine.checkoutRoot!.toUpperCase() },
    ];
    const cards = mergeBoard([], variants);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.key).toBe(`session:${mine.checkoutRoot}`);
    expect(cards[0]?.sessions).toHaveLength(4);
  });

  it('keeps two repository-less checkouts apart, and a session outside one on its own directory', () => {
    const mine: Session = { ...unlinked[0]!, repository: null };
    const elsewhere: Session = { ...mine, sessionId: 'elsewhere', checkoutRoot: `${mine.checkoutRoot}-other` };
    const loose: Session = { ...mine, sessionId: 'loose', checkoutRoot: null, branch: null, cwd: 'd:/notes' };

    expect(mergeBoard([], [mine, elsewhere, loose]).map((c) => c.key)).toEqual([
      `session:${mine.checkoutRoot}`,
      `session:${mine.checkoutRoot}-other`,
      'session:d:/notes',
    ]);
  });
});


describe('latest historical session fallback', () => {
  const issue = { ...issues[0]!, number: 42, url: 'https://github.com/org/repo/issues/42' };
  const past = (id: string, at: number, over = {}) => ({ agent: 'claude', sessionId: id, title: 'Past attempt', cwd: '/work/42-test', branch: '42-test', issueNumber: 42, repository: 'github.com/org/repo', updatedAt: at, ...over });
  it('chooses one newest modified session with a deterministic tie-break and without mutating inputs', () => {
    const history = [past('z', 10), past('b', 20), past('a', 20)];
    const card = mergeBoard([issue], [], history)[0]!;
    expect(card.lastSession?.sessionId).toBe('a');
    expect(card.sessions).toEqual([]);
    expect(history.map((s) => s.sessionId)).toEqual(['z', 'b', 'a']);
  });
  it('lets every live phase suppress history and excludes resumed ids even after their issue link changes', () => {
    for (const phase of ['running', 'waiting', 'idle'] as const) {
      const live = { ...sessions[0]!, agent: 'claude', issueNumber: 42, finished: false, activity: { phase, since: 1, at: 1, event: 'test' } };
      expect(mergeBoard([issue], [live], [past('old', 10)])[0]?.lastSession).toBeUndefined();
      const moved = { ...live, issueNumber: 43, sessionId: 'old' };
      expect(mergeBoard([issue], [moved], [past('old', 10)])[0]?.lastSession).toBeUndefined();
    }
  });
  it('requires matching repository evidence and ignores stale copies of a moved transcript', () => {
    expect(mergeBoard([issue], [], [past('old', 1, { repository: null }), past('other', 2, { repository: 'github.com/other/repo' })])[0]?.lastSession).toBeUndefined();
    expect(mergeBoard([issue], [], [past('moved', 1), past('moved', 2, { issueNumber: 43 })])[0]?.lastSession).toBeUndefined();
  });
  /**
   * How a session was started decides how it is opened and nothing else. A `SessionStart` maps to no phase, so a
   * resume wipes the reading its own process wrote — and the row would fall back to the CLI's word while the board's
   * own observation of that same session sat in the store.
   */
  it('gives a live session with no current reading its own kept one, whatever started it', () => {
    const base = { ...sessions[0]!, agent: 'claude', sessionId: 'live-one', issueNumber: 42, finished: false, activity: null };
    const kept = new Map([['claude:live-one', { phase: 'idle' as const, event: 'Stop', at: 20 }]]);

    expect(mergeBoard([issue], [{ ...base }], [], new Map(), kept)[0]?.sessions[0]?.activity).toEqual({
      phase: 'idle',
      since: 20,
      at: 20,
      event: 'Stop',
    });

    // A reading it already has outranks the kept one, and nothing is invented where the board never saw anything.
    const reading = { phase: 'running' as const, since: 5, at: 5, event: 'PostToolBatch' };

    expect(mergeBoard([issue], [{ ...base, activity: reading }], [], new Map(), kept)[0]?.sessions[0]?.activity).toEqual(reading);
    expect(mergeBoard([issue], [{ ...base }], [], new Map(), new Map())[0]?.sessions[0]?.activity).toBeNull();
  });

  /**
   * Whatever was working when the reading was taken is not working now: the marker went to no phase because a new
   * process took the session. A kept `running` handed to a live row would shimmer it and ring its card for a turn
   * that stopped, which is the same demotion `retainedPhase` makes on a saved session's row.
   */
  it('demotes a kept running reading to idle, and keeps a kept waiting one', () => {
    const base = { ...sessions[0]!, agent: 'claude', sessionId: 'live-two', issueNumber: 42, finished: false, activity: null };
    const phaseOf = (phase: 'running' | 'waiting' | 'idle') =>
      mergeBoard([issue], [{ ...base }], [], new Map(), new Map([['claude:live-two', { phase, event: 'PostToolBatch', at: 20 }]]))[0]
        ?.sessions[0]?.activity?.phase;

    expect(phaseOf('running')).toBe('idle');
    expect(phaseOf('waiting')).toBe('waiting');
    expect(phaseOf('idle')).toBe('idle');
  });

  it('carries the reading the board kept for that session, so closing its window does not blank the card', () => {
    const retained = new Map([['claude:old', { phase: 'waiting' as const, event: 'PreToolUse', at: 20 }]]);

    expect(mergeBoard([issue], [], [past('old', 10)], new Map(), retained)[0]?.lastSession?.retained).toEqual({
      phase: 'waiting',
      event: 'PreToolUse',
      at: 20,
    });
  });

  /** A reading is about one session, not about the card: the saved session on the card is a different attempt than the one that reported it. */
  it('carries no reading held under another session id, or under another agent', () => {
    const other = new Map([['claude:other', { phase: 'waiting' as const, event: 'PreToolUse', at: 20 }]]);
    const codex = new Map([['codex:old', { phase: 'waiting' as const, event: 'PreToolUse', at: 20 }]]);

    expect(mergeBoard([issue], [], [past('old', 10)], new Map(), other)[0]?.lastSession?.retained).toBeUndefined();
    expect(mergeBoard([issue], [], [past('old', 10)], new Map(), codex)[0]?.lastSession?.retained).toBeUndefined();
  });

  it('leaves the history it was handed unchanged, which several cards read in turn', () => {
    const history = [past('old', 10)];
    const retained = new Map([['claude:old', { phase: 'idle' as const, event: 'Stop', at: 20 }]]);

    mergeBoard([issue], [], history, new Map(), retained);

    expect(history[0]).not.toHaveProperty('retained');
  });

  it('never creates cards from history or puts finished-session activity on the fallback', () => {
    expect(mergeBoard([], [], [past('old', 1)])).toEqual([]);
    const finished = { ...sessions[0]!, issueNumber: 42, finished: true };
    expect(mergeBoard([issue], [finished], [past('old', 1)])[0]).toMatchObject({ sessions: [], lastSession: { sessionId: 'old' } });
  });
});
