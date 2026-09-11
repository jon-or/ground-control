import { describe, expect, it } from 'vitest';
import type { CheckoutReaders, Lane, LanedCard } from '@ground-control/core';
import { withCheckouts } from '../src/checkouts.js';

const ROOT = 'd:/work/repo';
const PICKED = 'd:/work/repo.worktrees/19002-refund-window';
const CONFIG = `[remote "origin"]\n url = https://github.com/org/repo.git`;

function card(over: Partial<LanedCard>): LanedCard {
  return {
    key: 'issue:19002',
    issue: null,
    issueNumber: 19002,
    sessions: [],
    lane: 'unstarted',
    returned: false,
    attention: null,
    reason: 'Assigned',
    ...over,
  };
}

function lanes(cards: LanedCard[]): Lane[] {
  return [{ id: 'unstarted', title: 'Unstarted', cards }];
}

const only = (all: Lane[]): LanedCard => all[0]!.cards[0]!;

/** No clone to search, for the blocks that are about checkouts rather than worktrees. */
const NO_SCAN = { roots: [], pattern: null, recorded: {} };

/** Counts what each card cost, which is the thing the pass-wide cache is for. */
function counting(dirs: readonly string[], config: Record<string, string> = {}): CheckoutReaders & { reads: string[] } {
  const reads: string[] = [];

  return {
    reads,
    listDir: (path) => (dirs.includes(path) ? [] : null),
    readText: (path) => {
      reads.push(path);

      return config[path] ?? null;
    },
  };
}

describe('the checkout each card carries', () => {
  const issue = {
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
  };

  it('leaves a card with nowhere to point an editor untouched, rather than giving it an empty one', () => {
    const drawn = only(withCheckouts(lanes([card({ issue })]), {}, counting([]), NO_SCAN));

    expect('checkout' in drawn).toBe(false);
  });

  it('carries the developer’s pick onto the card it was made for', () => {
    const readers = counting([PICKED], { [`${PICKED}/.git/config`]: CONFIG });
    const drawn = only(withCheckouts(lanes([card({ issue })]), { 'issue:19002': PICKED }, readers, NO_SCAN));

    expect(drawn.checkout).toEqual({ root: PICKED, source: 'remembered', only: true });
  });

  it('gives one card’s pick to that card alone', () => {
    const readers = counting([PICKED], { [`${PICKED}/.git/config`]: CONFIG });
    const other = card({ key: 'issue:19003', issueNumber: 19003, issue: { ...issue, number: 19003 } });
    const drawn = withCheckouts(lanes([card({ issue }), other]), { 'issue:19002': PICKED }, readers, NO_SCAN);

    expect(only(drawn).checkout?.root).toBe(PICKED);
    expect(drawn[0]!.cards[1]!.checkout).toBeUndefined();
  });

  // Cards sharing a checkout should reuse filesystem reads within a snapshot.
  it('reads one directory once however many cards resolve to it', () => {
    const readers = counting([PICKED], { [`${PICKED}/.git/config`]: CONFIG });
    const second = card({ key: 'issue:19003', issueNumber: 19003, issue: { ...issue, number: 19003 } });

    withCheckouts(lanes([card({ issue }), second]), { 'issue:19002': PICKED, 'issue:19003': PICKED }, readers, NO_SCAN);

    expect(readers.reads.filter((path) => path === `${PICKED}/.git/config`)).toHaveLength(1);
  });

  // The scan turns a clone the hub already knows into a worktree per card, with no pick and no session (R46).
  describe('and the worktree beside it', () => {
    const WORKTREE = 'd:/work/wt/19002-refund-window';

    /** One clone with one registered worktree, and the reads that identify each. */
    function clone(): CheckoutReaders & { reads: string[] } {
      const readers = counting([ROOT, WORKTREE], {
        [`${ROOT}/.git/HEAD`]: 'ref: refs/heads/master\n',
        [`${ROOT}/.git/config`]: CONFIG,
        [`${ROOT}/.git/worktrees/refund/gitdir`]: `${WORKTREE}/.git\n`,
        [`${ROOT}/.git/worktrees/refund/HEAD`]: 'ref: refs/heads/19002-refund-window\n',
      });

      return { ...readers, listDir: (path) => (path === `${ROOT}/.git/worktrees` ? ['refund'] : readers.listDir(path)) };
    }

    const scan = (readers: CheckoutReaders) => withCheckouts(lanes([card({ issue })]), {}, readers, { roots: [ROOT], pattern: /^(\d+)-/, recorded: {} });

    it('carries the worktree onto the card its branch names', () => {
      expect(only(scan(clone())).worktree).toEqual({ root: WORKTREE, branch: '19002-refund-window', only: true });
    });

    it('opens that worktree, since the card has no session and no pick', () => {
      expect(only(scan(clone())).checkout).toEqual({ root: WORKTREE, source: 'worktree', only: true });
    });

    it('finds no worktree with no clone to search', () => {
      const drawn = only(withCheckouts(lanes([card({ issue })]), {}, clone(), { roots: [], pattern: /^(\d+)-/, recorded: {} }));

      expect(drawn.worktree).toBeUndefined();
    });

    it('finds no worktree for a card of another repository', () => {
      const elsewhere = card({ key: 'issue:19002@other', issue: { ...issue, url: 'https://github.com/org/other/issues/19002' } });
      const drawn = withCheckouts(lanes([elsewhere]), {}, clone(), { roots: [ROOT], pattern: /^(\d+)-/, recorded: {} });

      expect(only(drawn).worktree).toBeUndefined();
    });

    it('gives one clone’s worktree to every card of that repository it names, not just the first', () => {
      const readers = clone();
      const second = card({ key: 'issue:19003', issueNumber: 19003, issue: { ...issue, number: 19003 } });
      const drawn = withCheckouts(lanes([second, card({ issue })]), {}, readers, { roots: [ROOT], pattern: /^(\d+)-/, recorded: {} });

      expect(drawn[0]!.cards.map((found) => found.worktree?.root)).toEqual([undefined, WORKTREE]);
    });

    // A worktree run reports where it made the worktree; the hub records that, and the name need not say the issue (R46).
    it('carries a recorded worktree onto its card whatever its branch is called', () => {
      const FREE = 'd:/work/wt/refund';
      const readers = counting([ROOT, FREE], {
        [`${ROOT}/.git/HEAD`]: 'ref: refs/heads/master\n',
        [`${ROOT}/.git/config`]: CONFIG,
        [`${ROOT}/.git/worktrees/free/gitdir`]: `${FREE}/.git\n`,
        [`${ROOT}/.git/worktrees/free/HEAD`]: 'ref: refs/heads/refund\n',
      });
      const disk = { ...readers, listDir: (path: string) => (path === `${ROOT}/.git/worktrees` ? ['free'] : readers.listDir(path)) };
      const drawn = only(withCheckouts(lanes([card({ issue })]), {}, disk, { roots: [ROOT], pattern: /^(\d+)-/, recorded: { 'issue:19002': FREE } }));

      expect(drawn.worktree).toEqual({ root: FREE, branch: 'refund', only: true });
      expect(drawn.checkout).toEqual({ root: FREE, source: 'worktree', only: true });
    });
  });

  it('preserves lane assignment and card order', () => {
    const readers = counting([ROOT], { [`${ROOT}/.git/config`]: CONFIG });
    const before = lanes([card({ issue }), card({ key: 'issue:2', issueNumber: 2 })]);
    const after = withCheckouts(before, {}, readers, NO_SCAN);

    expect(after.map((l) => l.id)).toEqual(['unstarted']);
    expect(after[0]!.cards.map((c) => c.key)).toEqual(['issue:19002', 'issue:2']);
    expect(after[0]!.cards.every((c) => c.lane === 'unstarted')).toBe(true);
  });
});
