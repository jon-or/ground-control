import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { READING_STANDS_MS } from '@ground-control/board';
import type { KnownIssues } from '@ground-control/board';
import type { CardReading, IssueCard, Session, WorkSource } from '@ground-control/core';
import { IssueLookup } from '../src/issueLookup.js';
import { makeIssueStore } from '../src/issueStore.js';
import { issuesPathOf } from '../src/paths.js';
import { captureLog, tempHome } from './helpers.js';

const REPO = 'github.com/example-org/example-repo';

/** Field order is `toCard`'s, not the storage schema's: a comparison that only holds for one of them holds for neither. */
function issue(number: number, over: Partial<IssueCard> = {}): IssueCard {
  return {
    number,
    title: `Issue ${number}`,
    state: 'OPEN',
    repository: 'example-org/example-repo',
    type: null,
    typeColor: null,
    url: `https://github.com/example-org/example-repo/issues/${number}`,
    status: '⚒️ Dev',
    statusColor: null,
    statusChangedAt: null,
    assignees: ['dev-1'],
    avatar: null,
    pullRequest: null,
    updatedAt: '2026-09-01T00:00:00Z',
    ...over,
  };
}

function session(number: number | null, over: Partial<Session> = {}): Session {
  return {
    agent: 'claude',
    sessionId: `session-${number ?? 'none'}`,
    cwd: 'c:/work/repo',
    checkoutRoot: 'c:/work/repo',
    branch: number === null ? 'main' : `${number}-something`,
    repository: REPO,
    issueNumber: number,
    startedAt: 1,
    finished: false,
    ...over,
  } as Session;
}

/** A source that answers by number and counts what it was asked, so a test can prove a read was never made. */
function sourceOf(answer: (repository: string, number: number) => CardReading | null): WorkSource & { asked: string[] } {
  const asked: string[] = [];
  const source = {
    id: 'github',
    displayName: 'GitHub',
    configure: () => null,
    read: async () => ({ items: null, failure: null, needs: null }),
    async readCard(repository: string, number: number): Promise<CardReading | null> {
      asked.push(`${repository}#${number}`);

      return answer(repository, number);
    },
    asked,
  };

  return source as WorkSource & { asked: string[] };
}

let home: string;
let dispose: () => void;
let changes: number;
let now: number;

beforeEach(() => {
  ({ home, dispose } = tempHome());
  changes = 0;
  now = 1_000;
});

afterEach(() => dispose());

function lookupOver(source: WorkSource, store = makeIssueStore(home)) {
  return {
    store,
    lookup: new IssueLookup({
      store,
      sources: () => [source],
      log: captureLog().log,
      now: () => now,
      changed: () => {
        changes++;
      },
    }),
  };
}

/** The lookup starts its reads without awaiting them, so a test waits for the microtasks they resolve on. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the issues a session names but the developer is not assigned', () => {
  it('names an issue it wrote down while it was still assigned, with no read at all', async () => {
    const source = sourceOf(() => ({ card: null, failure: null }));
    const { lookup } = lookupOver(source);

    lookup.consider([issue(42)], [], new Set([42]));
    await settled();

    // The assignment ends: the same session, and a read that no longer returns the issue.
    lookup.consider([], [session(42)], new Set());
    await settled();

    expect(source.asked).toEqual([]);
    expect(lookup.known([session(42)], new Set())?.get(42)?.title).toBe('Issue 42');
  });

  it('reads an issue it has never seen, once, and says so when it lands', async () => {
    const source = sourceOf((_repository, number) => ({ card: issue(number, { status: '🚦 QA' }), failure: null }));
    const { lookup } = lookupOver(source);

    lookup.consider([], [session(42)], new Set());
    await settled();
    lookup.consider([], [session(42)], new Set());
    await settled();

    expect(source.asked).toEqual([`${REPO}#42`]);
    expect(changes).toBe(1);
    expect(lookup.known([session(42)], new Set())?.get(42)?.status).toBe('🚦 QA');
  });

  it('says nothing about a number still being read, so the session keeps its checkout card until it lands', () => {
    const { lookup } = lookupOver(sourceOf(() => ({ card: issue(42), failure: null })));

    expect(lookup.known([session(42)], new Set()).size).toBe(0);
  });

  it('leaves an assigned number alone — the source already returned that card', async () => {
    const source = sourceOf(() => ({ card: issue(42), failure: null }));
    const { lookup } = lookupOver(source);

    lookup.consider([issue(42)], [session(42)], new Set([42]));
    await settled();

    expect(source.asked).toEqual([]);
    expect(lookup.known([session(42)], new Set([42])).size).toBe(0);
  });

  it('reads nothing for a session whose checkout names no repository to key it under', async () => {
    const source = sourceOf(() => ({ card: issue(42), failure: null }));
    const { lookup } = lookupOver(source);

    lookup.consider([], [session(42, { repository: null })], new Set());
    await settled();

    expect(source.asked).toEqual([]);
  });

  it('reads nothing for a session naming no issue at all', async () => {
    const source = sourceOf(() => ({ card: issue(42), failure: null }));
    const { lookup } = lookupOver(source);

    lookup.consider([], [session(null)], new Set());
    await settled();

    expect(source.asked).toEqual([]);
  });
});

describe('a number that names nothing', () => {
  it('is remembered, so the board asks once rather than on every poll', async () => {
    const source = sourceOf(() => ({ card: null, failure: null }));
    const { lookup } = lookupOver(source);

    lookup.consider([], [session(99)], new Set());
    await settled();
    lookup.consider([], [session(99)], new Set());
    await settled();

    expect(source.asked).toEqual([`${REPO}#99`]);
    expect(lookup.known([session(99)], new Set()).size).toBe(0);
  });

  it('is asked again once an issue could have been filed since', async () => {
    const source = sourceOf(() => ({ card: null, failure: null }));
    const { lookup } = lookupOver(source);

    lookup.consider([], [session(99)], new Set());
    await settled();
    now += READING_STANDS_MS + 1;
    lookup.consider([], [session(99)], new Set());
    await settled();

    expect(source.asked).toHaveLength(2);
  });
});

describe('a read that failed', () => {
  it('is not remembered as an answer — an unreachable GitHub is not an issue that does not exist', async () => {
    const source = sourceOf(() => ({
      card: null,
      failure: { subject: 'github', kind: 'offline', message: 'no network', remedy: 'try later' },
    }));
    const { lookup, store } = lookupOver(source);

    lookup.consider([], [session(42)], new Set());
    await settled();

    expect(store.read().entries['github.com/example-org/example-repo#42']).toBeUndefined();

    // Held off rather than retried: the session poll comes round twice a minute, and an outage does not lift that fast.
    lookup.consider([], [session(42)], new Set());
    await settled();

    expect(source.asked).toHaveLength(1);

    now += 5 * 60 * 1000 + 1;
    lookup.consider([], [session(42)], new Set());
    await settled();

    expect(source.asked).toHaveLength(2);
  });

  /** A source that does not serve the repository is not a source that says the issue does not exist. */
  it('writes nothing down when no source serves the repository at all', async () => {
    const { lookup, store } = lookupOver(sourceOf(() => null));

    lookup.consider([], [session(42)], new Set());
    await settled();

    expect(store.read().entries).toEqual({});
  });
});

describe('what the file holds', () => {
  it('writes the assigned cards down, and prunes what nothing has named for long enough', async () => {
    const { lookup, store } = lookupOver(sourceOf(() => ({ card: null, failure: null })));

    lookup.consider([issue(42), issue(43)], [], new Set([42, 43]));
    await settled();

    expect(Object.keys(store.read().entries).sort()).toEqual([`${REPO}#42`, `${REPO}#43`]);

    now += 40 * 24 * 60 * 60 * 1000;
    lookup.consider([issue(42)], [], new Set([42]));
    await settled();

    expect(Object.keys(store.read().entries)).toEqual([`${REPO}#42`]);
  });

  it('does not rewrite the file when a poll read the same board again', async () => {
    const { lookup } = lookupOver(sourceOf(() => ({ card: null, failure: null })));

    lookup.consider([issue(42)], [], new Set([42]));
    await settled();
    const first = readFileSync(issuesPathOf(home), 'utf8');

    now += 5_000;
    lookup.consider([issue(42)], [], new Set([42]));
    await settled();

    expect(readFileSync(issuesPathOf(home), 'utf8')).toBe(first);
  });

  it('records a card that actually changed', async () => {
    const { lookup, store } = lookupOver(sourceOf(() => ({ card: null, failure: null })));

    lookup.consider([issue(42)], [], new Set([42]));
    await settled();
    lookup.consider([issue(42, { status: '🔍 Dev Review' })], [], new Set([42]));
    await settled();

    const entry = store.read().entries[`${REPO}#42`] as { card: IssueCard };

    expect(entry.card.status).toBe('🔍 Dev Review');
  });

  it('reads a file that is not JSON at all as nothing looked up, rather than throwing on every render', () => {
    const store = makeIssueStore(home);

    store.write({ entries: {} });
    writeFileSync(issuesPathOf(home), 'not json {');

    expect(store.read()).toEqual({ entries: {} } satisfies KnownIssues);
  });
});

it('stops starting reads once it is disposed', async () => {
  const source = sourceOf(() => ({ card: issue(42), failure: null }));
  const { lookup } = lookupOver(source);

  lookup.dispose();
  lookup.consider([], [session(42)], new Set());
  await settled();

  expect(source.asked).toEqual([]);
});
