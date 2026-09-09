import { describe, expect, it } from 'vitest';
import { checkoutFor } from '../src/checkout.js';
import type { CheckoutReaders } from '../src/checkout.js';
import type { IssueCard } from '../src/cards.js';
import type { HistoricalSession, Session } from '../src/types.js';

/**
 * Whole, not cast: a partial literal would go on compiling the day `Session` grows a field, and the pick reads
 * three of its timestamps. A moved `cwd` moves the checkout with it unless a row says otherwise, which is the
 * ordinary case — a session started below its checkout is the exception and names both.
 */
function session(over: Partial<Session> = {}): Session {
  const cwd = over.cwd ?? 'd:/work/repo.worktrees/18941-inbox-badge';

  return {
    agent: 'claude',
    sessionId: 'a1b2c3d4-0000-4000-8000-000000000000',
    pid: 4242,
    title: 'the session',
    cwd,
    checkoutRoot: cwd,
    startedAt: 1_788_000_000_000,
    branch: '18941-inbox-badge',
    repository: 'github.com/org/repo',
    issueNumber: 18941,
    transcriptWrittenAt: null,
    activity: null,
    finished: false,
    attachId: null,
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

describe('which of a card’s directories its work is in', () => {
  /** Every directory reads back, because this block is about which session wins rather than whether one is there. */
  const anywhere: CheckoutReaders = { listDir: () => [], readText: () => null };

  function pick(card: { sessions: Session[]; lastSession?: HistoricalSession }) {
    return checkoutFor({ ...card, issue: null }, undefined, anywhere);
  }

  it('is nothing at all where the card has no session and no saved one', () => {
    expect(pick({ sessions: [] })).toBeNull();
  });

  it('is the session directory where there is one', () => {
    expect(pick({ sessions: [session()] })?.root).toBe('d:/work/repo.worktrees/18941-inbox-badge');
  });

  it('is the saved session directory where every session has ended', () => {
    expect(pick({ sessions: [], lastSession: historical })?.root).toBe('d:/work/repo.worktrees/18953-lane-divider');
  });

  it('prefers a live session to a saved one, which a card carrying both would otherwise decide by luck', () => {
    expect(pick({ sessions: [session()], lastSession: historical })?.root).toBe('d:/work/repo.worktrees/18941-inbox-badge');
  });

  it('takes the most recently active rather than the most recently started', () => {
    // The newer process is a session just opened in the main clone; the work is in the older worktree session,
    // which has been writing its transcript. Picking by `startedAt` would answer with the clone.
    const working = session({ sessionId: 'older', startedAt: 1_788_000_000_000, transcriptWrittenAt: 1_788_000_900_000 });
    const justOpened = session({ sessionId: 'newer', cwd: 'd:/work/repo', startedAt: 1_788_000_600_000 });

    expect(pick({ sessions: [justOpened, working] })?.root).toBe('d:/work/repo.worktrees/18941-inbox-badge');
  });

  it('reads an activity signal as being active, over a transcript and a start', () => {
    const signalled = session({ sessionId: 'signalled', activity: { phase: 'running', since: 1_788_002_000_000, at: 1_788_002_000_000, event: 'UserPromptSubmit' } });
    const wrote = session({ sessionId: 'wrote', cwd: 'd:/work/repo', transcriptWrittenAt: 1_788_001_000_000 });

    expect(pick({ sessions: [wrote, signalled] })?.root).toBe('d:/work/repo.worktrees/18941-inbox-badge');
  });

  it('is the only checkout where every session shares one, and says so', () => {
    const twin = session({ sessionId: 'twin' });

    expect(pick({ sessions: [session(), twin] })).toEqual({
      root: 'd:/work/repo.worktrees/18941-inbox-badge',
      source: 'session',
      only: true,
    });
  });

  // Which of two directories was picked is invisible on the card, whose sessions are listed newest-started first.
  // Saying so is what lets the editor name the one it took.
  it('is not the only checkout where the sessions are spread over two, and says that', () => {
    const elsewhere = session({ sessionId: 'elsewhere', cwd: 'd:/work/repo' });

    expect(pick({ sessions: [session(), elsewhere] })?.only).toBe(false);
  });

  it('is the checkout, not the subdirectory a session was started in', () => {
    const below = session({ sessionId: 'below', cwd: 'd:/work/repo/packages/core', checkoutRoot: 'd:/work/repo' });

    expect(pick({ sessions: [below] })).toEqual({ root: 'd:/work/repo', source: 'session', only: true });
  });

  it('reads two sessions of one checkout as one, however far below it they were started', () => {
    const root = session({ sessionId: 'root', cwd: 'd:/work/repo' });
    const below = session({ sessionId: 'below', cwd: 'd:/work/repo/packages/core', checkoutRoot: 'd:/work/repo' });

    expect(pick({ sessions: [root, below] })).toEqual({ root: 'd:/work/repo', source: 'session', only: true });
  });

  it('reads one directory two agents cased differently as one checkout', () => {
    const cased = session({ agent: 'codex', sessionId: 'cased', cwd: 'D:\\work\\repo.worktrees\\18941-inbox-badge' });

    expect(pick({ sessions: [session(), cased] })?.only).toBe(true);
  });

  it('is the only checkout on a card whose sessions have all ended', () => {
    expect(pick({ sessions: [], lastSession: historical })?.only).toBe(true);
  });

  it('breaks a tie on agent then session id, so one board does not disagree with another', () => {
    const codex = session({ agent: 'codex', sessionId: 'zzz', cwd: 'd:/work/a' });
    const claudeB = session({ agent: 'claude', sessionId: 'bbb', cwd: 'd:/work/b' });
    const claudeA = session({ agent: 'claude', sessionId: 'aaa', cwd: 'd:/work/c' });

    expect(pick({ sessions: [codex, claudeB, claudeA] })?.root).toBe('d:/work/c');
    expect(pick({ sessions: [claudeA, claudeB, codex] })?.root).toBe('d:/work/c');
  });

  it('leaves the list on the card alone, which an in-place sort would reorder on every render', () => {
    const first = session({ sessionId: 'first', startedAt: 1 });
    const second = session({ sessionId: 'second', startedAt: 2 });
    const sessions = [first, second];

    pick({ sessions });

    expect(sessions.map((s) => s.sessionId)).toEqual(['first', 'second']);
  });
});

/**
 * A checkout the board is willing to point an editor at. The two sources are worth telling apart because only one
 * of them is evidence the developer gave: a session ran there, or they said so. Nothing infers a third.
 */
describe('the checkout a card can be opened in', () => {
  const WORKTREE = 'd:/work/repo.worktrees/18941-inbox-badge';
  const PICKED = 'd:/work/repo.worktrees/19002-refund-window';

  const issue = (over: Partial<IssueCard> = {}): IssueCard => ({
    number: 19002,
    title: 'Refund window',
    repository: 'org/repo',
    type: null,
    typeColor: null,
    url: 'https://github.com/org/repo/issues/19002',
    status: null,
    statusColor: null,
    statusChangedAt: null,
    assignees: [],
    avatar: null,
    pullRequest: null,
    updatedAt: '2026-09-08T00:00:00Z',
    ...over,
  });

  /** Directories that are there, and the git config each answers with. An unlisted path is one that is not there. */
  function machine(dirs: readonly string[], config: Record<string, string> = {}): CheckoutReaders {
    return {
      listDir: (path) => (dirs.includes(path) ? [] : null),
      readText: (path) => config[path] ?? null,
    };
  }

  const originOf = (root: string, remote: string): Record<string, string> => ({
    [`${root}/.git/config`]: `[remote "origin"]\n url = ${remote}`,
  });

  it('is the session directory, named as the session it came from', () => {
    expect(checkoutFor({ sessions: [session()], issue: issue() }, undefined, machine([WORKTREE]))).toEqual({
      root: WORKTREE,
      source: 'session',
      only: true,
    });
  });

  it('carries `only` through from the sessions, so a caller can say which of two it took', () => {
    const elsewhere = session({ sessionId: 'elsewhere', cwd: 'd:/work/repo' });

    expect(checkoutFor({ sessions: [session(), elsewhere], issue: issue() }, undefined, machine([WORKTREE, 'd:/work/repo']))?.only).toBe(false);
  });

  // M23: a deleted directory something still holds keeps its name and refuses everything, and `code <it>` would
  // open a window on nothing. A saved session is where this bites — the transcript outlives the worktree.
  it('is nothing where the directory a session recorded has gone', () => {
    expect(checkoutFor({ sessions: [], lastSession: historical, issue: issue() }, undefined, machine([]))).toBeNull();
  });

  // The deleted worktree is still held by a process, so its session goes on being reported and goes on ranking
  // first. Collapsing to that one session would hide the second agent's perfectly good checkout.
  it('passes over a session whose directory has gone, to one that is still there', () => {
    const held = session({ sessionId: 'held', transcriptWrittenAt: 1_788_009_000_000 });
    const working = session({ sessionId: 'working', cwd: 'd:/work/repo', checkoutRoot: 'd:/work/repo' });

    expect(checkoutFor({ sessions: [held, working], issue: issue() }, undefined, machine(['d:/work/repo']))).toEqual({
      root: 'd:/work/repo',
      source: 'session',
      only: true,
    });
  });

  // `only` says whether the card's work is spread over more than one place, and a directory that is gone is not
  // one of them — saying otherwise makes the editor name a checkout nobody can open to tell it from another.
  it('counts only the directories that are there when it says whether there is one', () => {
    const gone = session({ sessionId: 'gone', cwd: 'd:/work/deleted', checkoutRoot: 'd:/work/deleted' });

    expect(checkoutFor({ sessions: [session(), gone], issue: issue() }, undefined, machine([WORKTREE]))?.only).toBe(true);
  });

  it('is nothing at all for a card with no session and no pick', () => {
    expect(checkoutFor({ sessions: [], issue: issue() }, undefined, machine([WORKTREE]))).toBeNull();
  });

  it('is the developer’s own pick where they made one and nothing has run', () => {
    const readers = machine([PICKED], originOf(PICKED, 'git@github.com:Org/Repo.git'));

    expect(checkoutFor({ sessions: [], issue: issue() }, PICKED, readers)).toEqual({ root: PICKED, source: 'remembered', only: true });
  });

  // A session is where work is actually happening; a pick is where the developer expected it to. The first outranks
  // the second, or a card whose agent moved to a worktree would keep opening the directory nobody is working in.
  it('prefers the session directory to the pick', () => {
    const readers = machine([WORKTREE, PICKED], originOf(PICKED, 'git@github.com:Org/Repo.git'));

    expect(checkoutFor({ sessions: [session()], issue: issue() }, PICKED, readers)?.root).toBe(WORKTREE);
  });

  it('drops a pick whose directory has gone', () => {
    expect(checkoutFor({ sessions: [], issue: issue() }, PICKED, machine([]))).toBeNull();
  });

  // The worktree was deleted and its path reused for another repository's checkout. A stored path is not a claim
  // that the directory is still the one that was picked.
  it('drops a pick that no longer belongs to the card’s own repository', () => {
    const readers = machine([PICKED], originOf(PICKED, 'https://github.com/org/other-repo.git'));

    expect(checkoutFor({ sessions: [], issue: issue() }, PICKED, readers)).toBeNull();
  });

  it('drops a pick in a directory under no repository at all', () => {
    expect(checkoutFor({ sessions: [], issue: issue() }, PICKED, machine([PICKED]))).toBeNull();
  });

  // R4 work has no issue to match a repository against, so there is nothing a pick could be checked for. Such a
  // card always carries a running session anyway, which is the source that answers it.
  it('takes no pick on a card with no issue', () => {
    const readers = machine([PICKED], originOf(PICKED, 'git@github.com:Org/Repo.git'));

    expect(checkoutFor({ sessions: [], issue: null }, PICKED, readers)).toBeNull();
  });

  // Ad-hoc work outside any checkout is still somewhere an editor can be pointed at, so the session branch asks
  // whether the directory is there and not whether git knows it.
  it('opens a session directory under no repository', () => {
    const loose = session({ cwd: 'd:/scratch', checkoutRoot: null });

    expect(checkoutFor({ sessions: [loose], issue: null }, undefined, machine(['d:/scratch']))?.root).toBe('d:/scratch');
  });
});
