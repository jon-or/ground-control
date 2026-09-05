import { describe, expect, it } from 'vitest';
import { checkoutOf } from '../src/board.js';
import type { HistoricalSession, Session } from '../src/types.js';

/**
 * Whole, not cast: a partial literal would go on compiling the day `Session` grows a field, and the pick reads
 * three of its timestamps.
 */
function session(over: Partial<Session> = {}): Session {
  return {
    agent: 'claude',
    sessionId: 'a1b2c3d4-0000-4000-8000-000000000000',
    pid: 4242,
    title: 'the session',
    cwd: 'd:/work/repo.worktrees/18941-inbox-badge',
    startedAt: 1_788_000_000_000,
    branch: '18941-inbox-badge',
    issueNumber: 18941,
    transcriptWrittenAt: null,
    activity: null,
    finished: false,
    details: { kind: 'interactive' },
    ...over,
  };
}

const historical: HistoricalSession = {
  agent: 'claude',
  sessionId: 'past',
  title: 'Past attempt',
  cwd: 'd:/work/repo.worktrees/18953-lane-divider',
  branch: '18953-lane-divider',
  issueNumber: 18953,
  repository: 'github.com/org/repo',
  updatedAt: 1_787_000_000_000,
};

describe('the checkout a card is working in', () => {
  it('is nothing at all where the card has no session and no saved one', () => {
    expect(checkoutOf({ sessions: [] })).toBeNull();
  });

  it('is the session directory where there is one', () => {
    expect(checkoutOf({ sessions: [session()] })?.cwd).toBe('d:/work/repo.worktrees/18941-inbox-badge');
  });

  it('is the saved session directory where every session has ended', () => {
    expect(checkoutOf({ sessions: [], lastSession: historical })?.cwd).toBe('d:/work/repo.worktrees/18953-lane-divider');
  });

  it('prefers a live session to a saved one, which a card carrying both would otherwise decide by luck', () => {
    expect(checkoutOf({ sessions: [session()], lastSession: historical })?.cwd).toBe('d:/work/repo.worktrees/18941-inbox-badge');
  });

  it('takes the most recently active rather than the most recently started', () => {
    // The newer process is a session just opened in the main clone; the work is in the older worktree session,
    // which has been writing its transcript. Picking by `startedAt` would answer with the clone.
    const working = session({ sessionId: 'older', startedAt: 1_788_000_000_000, transcriptWrittenAt: 1_788_000_900_000 });
    const justOpened = session({ sessionId: 'newer', cwd: 'd:/work/repo', startedAt: 1_788_000_600_000 });

    expect(checkoutOf({ sessions: [justOpened, working] })?.cwd).toBe('d:/work/repo.worktrees/18941-inbox-badge');
  });

  it('reads an activity signal as being active, over a transcript and a start', () => {
    const signalled = session({ sessionId: 'signalled', activity: { phase: 'running', since: 1_788_002_000_000, event: 'UserPromptSubmit' } });
    const wrote = session({ sessionId: 'wrote', cwd: 'd:/work/repo', transcriptWrittenAt: 1_788_001_000_000 });

    expect(checkoutOf({ sessions: [wrote, signalled] })?.cwd).toBe('d:/work/repo.worktrees/18941-inbox-badge');
  });

  it('is the only checkout where every session shares one, and says so', () => {
    const twin = session({ sessionId: 'twin' });

    expect(checkoutOf({ sessions: [session(), twin] })).toEqual({
      cwd: 'd:/work/repo.worktrees/18941-inbox-badge',
      only: true,
    });
  });

  // Which of two directories was picked is invisible on the card, whose sessions are listed newest-started first.
  // Saying so is what lets the editor name the one it took.
  it('is not the only checkout where the sessions are spread over two, and says that', () => {
    const elsewhere = session({ sessionId: 'elsewhere', cwd: 'd:/work/repo' });

    expect(checkoutOf({ sessions: [session(), elsewhere] })?.only).toBe(false);
  });

  it('reads one directory two agents cased differently as one checkout', () => {
    const cased = session({ agent: 'codex', sessionId: 'cased', cwd: 'D:\\work\\repo.worktrees\\18941-inbox-badge' });

    expect(checkoutOf({ sessions: [session(), cased] })?.only).toBe(true);
  });

  it('is the only checkout on a card whose sessions have all ended', () => {
    expect(checkoutOf({ sessions: [], lastSession: historical })?.only).toBe(true);
  });

  it('breaks a tie on agent then session id, so one board does not disagree with another', () => {
    const codex = session({ agent: 'codex', sessionId: 'zzz', cwd: 'd:/work/a' });
    const claudeB = session({ agent: 'claude', sessionId: 'bbb', cwd: 'd:/work/b' });
    const claudeA = session({ agent: 'claude', sessionId: 'aaa', cwd: 'd:/work/c' });

    expect(checkoutOf({ sessions: [codex, claudeB, claudeA] })?.cwd).toBe('d:/work/c');
    expect(checkoutOf({ sessions: [claudeA, claudeB, codex] })?.cwd).toBe('d:/work/c');
  });

  it('leaves the list on the card alone, which an in-place sort would reorder on every render', () => {
    const first = session({ sessionId: 'first', startedAt: 1 });
    const second = session({ sessionId: 'second', startedAt: 2 });
    const sessions = [first, second];

    checkoutOf({ sessions });

    expect(sessions.map((s) => s.sessionId)).toEqual(['first', 'second']);
  });
});

/**
 * The board draws its Changes control on exactly the cards this hands a checkout for, and `media/board.js` is a
 * classic script that can import nothing — so the condition exists there too. These are the rows that pin the two
 * together; `extensions/ground-control/test/board.test.ts` asserts the same ones against the drawn control.
 */
describe('which cards have a checkout, against the board', () => {
  const other = session({ sessionId: 'session-2', cwd: 'd:/work/other' });

  const rows: [string, Parameters<typeof checkoutOf>[0], boolean][] = [
    ['one live session', { sessions: [session()] }, true],
    ['two live sessions', { sessions: [session(), other] }, true],
    ['no session, one saved', { sessions: [], lastSession: historical }, true],
    ['a live session and a saved one', { sessions: [session()], lastSession: historical }, true],
    ['no session at all', { sessions: [] }, false],
  ];

  it.each(rows)('a card with %s', (_row, card, expected) => {
    expect(checkoutOf(card) !== null).toBe(expected);
  });
});
