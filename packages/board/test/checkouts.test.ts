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
    const drawn = only(withCheckouts(lanes([card({ issue })]), {}, counting([])));

    expect('checkout' in drawn).toBe(false);
  });

  it('carries the developer’s pick onto the card it was made for', () => {
    const readers = counting([PICKED], { [`${PICKED}/.git/config`]: CONFIG });
    const drawn = only(withCheckouts(lanes([card({ issue })]), { 'issue:19002': PICKED }, readers));

    expect(drawn.checkout).toEqual({ root: PICKED, source: 'remembered', only: true });
  });

  it('gives one card’s pick to that card alone', () => {
    const readers = counting([PICKED], { [`${PICKED}/.git/config`]: CONFIG });
    const other = card({ key: 'issue:19003', issueNumber: 19003, issue: { ...issue, number: 19003 } });
    const drawn = withCheckouts(lanes([card({ issue }), other]), { 'issue:19002': PICKED }, readers);

    expect(only(drawn).checkout?.root).toBe(PICKED);
    expect(drawn[0]!.cards[1]!.checkout).toBeUndefined();
  });

  // Fifteen cards in one clone would otherwise walk the same `.git`, `commondir` and `config` fifteen times for an
  // answer that cannot differ inside one snapshot.
  it('reads one directory once however many cards resolve to it', () => {
    const readers = counting([PICKED], { [`${PICKED}/.git/config`]: CONFIG });
    const second = card({ key: 'issue:19003', issueNumber: 19003, issue: { ...issue, number: 19003 } });

    withCheckouts(lanes([card({ issue }), second]), { 'issue:19002': PICKED, 'issue:19003': PICKED }, readers);

    expect(readers.reads.filter((path) => path === `${PICKED}/.git/config`)).toHaveLength(1);
  });

  it('leaves the lane and its order alone, since where a card can be opened is not what stage it is at', () => {
    const readers = counting([ROOT], { [`${ROOT}/.git/config`]: CONFIG });
    const before = lanes([card({ issue }), card({ key: 'issue:2', issueNumber: 2 })]);
    const after = withCheckouts(before, {}, readers);

    expect(after.map((l) => l.id)).toEqual(['unstarted']);
    expect(after[0]!.cards.map((c) => c.key)).toEqual(['issue:19002', 'issue:2']);
    expect(after[0]!.cards.every((c) => c.lane === 'unstarted')).toBe(true);
  });
});
