import { describe, expect, it } from 'vitest';
import {
  KNOWN_ISSUE_TTL_MS,
  READING_STANDS_MS,
  knownIssueHolds,
  knownIssueKey,
  pruneKnownIssues,
  readKnownIssues,
  sameKnownCard,
  withKnownIssue,
} from '../src/index.js';
import type { IssueCard } from '../src/types.js';

const card: IssueCard = {
  number: 42,
  title: 'Guest portal drops rows past the first page',
  repository: 'example-org/example-repo',
  state: 'CLOSED',
  type: null,
  typeColor: null,
  url: 'https://github.com/example-org/example-repo/issues/42',
  status: '🚀 Releasable',
  statusColor: 'GRAY',
  statusChangedAt: null,
  assignees: ['dev-2'],
  avatar: null,
  pullRequest: null,
  updatedAt: '2026-09-01T00:00:00Z',
};

const key = knownIssueKey('github.com/example-org/example-repo', 42);

describe('the issues the board has looked up', () => {
  it('keys an issue by its repository and number, so two repositories never answer for each other', () => {
    expect(key).toBe('github.com/example-org/example-repo#42');
    expect(knownIssueKey('github.com/other-org/other-repo', 42)).not.toBe(key);
  });

  it('round-trips a card through the shape it is stored in', () => {
    const stored = JSON.parse(JSON.stringify(withKnownIssue({ entries: {} }, key, card, 1000)));

    expect(readKnownIssues(stored)).toEqual({ entries: { [key]: { card, at: 1000 } } });
  });

  it('records a number that named nothing, so the board asks once rather than every poll', () => {
    expect(withKnownIssue({ entries: {} }, key, null, 1000)).toEqual({ entries: { [key]: { missing: true, at: 1000 } } });
  });

  it('reads a file that is not this shape at all as no lookups', () => {
    expect(readKnownIssues(null)).toEqual({ entries: {} });
    expect(readKnownIssues([])).toEqual({ entries: {} });
    expect(readKnownIssues({ entries: 'nonsense' })).toEqual({ entries: {} });
  });

  it('drops one unreadable entry rather than every other issue beside it', () => {
    const state = readKnownIssues({ entries: { [key]: { card, at: 1 }, bad: { card: { number: 'seven' }, at: 1 } } });

    expect(Object.keys(state.entries)).toEqual([key]);
  });

  it('keeps a stored card missing a field a later build added, rather than reading the issue again', () => {
    const older = { ...card } as Partial<IssueCard>;
    delete older.state;
    delete older.repository;

    expect(readKnownIssues({ entries: { [key]: { card: older, at: 1 } } }).entries[key]).toEqual({ card: older, at: 1 });
  });
});

describe('how long a reading stands', () => {
  /** Nothing refreshes a card once the developer is unassigned, so without this it names that status for ever. */
  it('takes a card again once it is old enough to be describing an issue that has moved on', () => {
    expect(knownIssueHolds({ card, at: 0 }, READING_STANDS_MS - 1)).toBe(true);
    expect(knownIssueHolds({ card, at: 0 }, READING_STANDS_MS + 1)).toBe(false);
  });

  it('lets a number that named nothing be asked again, for an issue filed after the branch was cut', () => {
    expect(knownIssueHolds({ missing: true, at: 0 }, READING_STANDS_MS - 1)).toBe(true);
    expect(knownIssueHolds({ missing: true, at: 0 }, READING_STANDS_MS + 1)).toBe(false);
  });

  it('holds nothing for a key never read', () => {
    expect(knownIssueHolds(undefined, 0)).toBe(false);
  });
});

describe('pruning', () => {
  const state = { entries: { [key]: { card, at: 0 }, 'github.com/example-org/example-repo#7': { card, at: 0 } } };

  it('keeps what something still names, however old the reading is', () => {
    const kept = pruneKnownIssues(state, new Set([key]), KNOWN_ISSUE_TTL_MS * 2);

    expect(Object.keys(kept.entries)).toEqual([key]);
  });

  it('keeps a recent reading nothing names, so the next session naming it costs no round trip', () => {
    expect(Object.keys(pruneKnownIssues(state, new Set(), KNOWN_ISSUE_TTL_MS - 1).entries)).toHaveLength(2);
  });

  it('drops a reading nothing has named for longer than the board keeps one', () => {
    expect(pruneKnownIssues(state, new Set(), KNOWN_ISSUE_TTL_MS + 1)).toEqual({ entries: {} });
  });
});

describe('whether a card has changed since it was stored', () => {
  /**
   * A stored card comes back in the schema's key order and a fresh one in the source's, so this is the whole of what
   * keeps `issues.json` from being rewritten on every poll.
   */
  it('reads a card whose keys are in another order as the same card', () => {
    const reordered = Object.fromEntries(Object.entries(card).reverse()) as unknown as IssueCard;

    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(card));
    expect(sameKnownCard({ card, at: 0 }, reordered)).toBe(true);
  });

  it('reads a card whose status has moved as a different card', () => {
    expect(sameKnownCard({ card, at: 0 }, { ...card, status: '🔍 Dev Review' })).toBe(false);
  });

  it('reads a card whose pull request appeared as a different card', () => {
    const withPr = { ...card, pullRequest: { number: 7, url: 'u', state: 'OPEN', author: null, isDraft: false, reviewDecision: null } };

    expect(sameKnownCard({ card, at: 0 }, withPr)).toBe(false);
  });

  it('is never the same as a key never read, or as one that named nothing', () => {
    expect(sameKnownCard(undefined, card)).toBe(false);
    expect(sameKnownCard({ missing: true, at: 0 }, card)).toBe(false);
  });
});
