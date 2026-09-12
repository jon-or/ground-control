import { describe, expect, it } from 'vitest';
import type { CustodyHistory, IssueCard } from '@ground-control/core';
import { fetchCustody } from '../src/custody.js';
import type { GhRunner } from '../src/index.js';
import { config, fixture, runnerOf } from './helpers.js';

function card(over: Partial<IssueCard> = {}): IssueCard {
  return {
    number: 18845,
    title: 'Owner statements omit the cleaning fee',
    type: 'Bug',
    typeColor: 'RED',
    url: 'https://github.com/example-org/example-repo/issues/18845',
    status: '🚀 Releasable',
    statusColor: 'GREEN',
    statusChangedAt: '2026-09-11T00:55:29Z',
    assignees: [],
    avatar: null,
    pullRequest: null,
    updatedAt: '2026-09-11T00:55:29Z',
    ...over,
  };
}

/** The recorded pages of one issue: `custody-issue.json` and `custody-paged.json` each hold one. */
function pages(name: string): unknown[] {
  return fixture(name) as unknown[];
}

type Page = { data: { repository: { issue: { timelineItems: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: unknown[] } } } } };

/**
 * Split one recorded page in two at `at`, deriving the cursor the API would hand back. Neither sampled issue
 * needed a second page, and the API cannot produce one on demand.
 */
function split(name: string, at: number): [Page, Page] {
  const page = pages(name)[0] as Page;
  const second = structuredClone(page);
  const first = structuredClone(page);
  const nodes = page.data.repository.issue.timelineItems.nodes;

  first.data.repository.issue.timelineItems = { pageInfo: { hasNextPage: true, endCursor: 'Y3Vyc29yOnYyOpK5MjAyNi0wOA==' }, nodes: nodes.slice(0, at) };
  second.data.repository.issue.timelineItems = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: nodes.slice(at) };

  return [first, second];
}

async function historyOf(run: GhRunner, cfg = config(), over: Partial<IssueCard> = {}): Promise<CustodyHistory> {
  const reading = await fetchCustody(cfg, card(over), run, new AbortController().signal);

  expect(reading.failure).toBeNull();

  if (reading.history === null) {
    throw new Error('expected a history');
  }

  return reading.history;
}

describe('fetchCustody', () => {
  it('reads the issue and its status, assignment, and close events oldest first, with the configured project only', async () => {
    const run = runnerOf(...pages('custody-issue'));
    const history = await historyOf(run);

    expect(history).toMatchObject({ number: 18845, state: 'CLOSED', createdAt: '2026-08-12T12:35:11Z', closedAt: '2026-09-07T17:58:14Z', closedBy: 'dev-8', truncated: false });
    expect(history.events).toHaveLength(20);
    expect(history.events[0]).toEqual({ at: '2026-08-12T12:35:15Z', actor: 'dev-3', automated: false, status: { from: null, to: '🆕 New' }, assigned: null, unassigned: null });
    expect(history.events[1]).toEqual({ at: '2026-08-20T16:50:55Z', actor: 'dev-4', automated: false, status: null, assigned: 'dev-5', unassigned: null });
    expect(history.events[4]).toMatchObject({ actor: 'dev-5', unassigned: 'dev-5' });
    expect(history.events.map((event) => event.at)).toEqual([...history.events.map((event) => event.at)].sort());

    const [args, options] = [run.calls[0], run.bounds[0]];

    expect(args?.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(args).toContain('owner=example-org');
    expect(args).toContain('name=example-repo');
    expect(args).toContain('number=18845');
    expect(args?.some((arg) => arg.startsWith('after='))).toBe(false);
    expect(options).toMatchObject({ timeoutMs: 20_000 });
  });

  it('follows hasNextPage with the end cursor and keeps every page in order', async () => {
    const [first, second] = split('custody-paged', 40);
    const run = runnerOf(first, second);
    const history = await historyOf(run, config(), { number: 15505, url: 'https://github.com/example-org/example-repo/issues/15505' });

    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]).toContain('after=Y3Vyc29yOnYyOpK5MjAyNi0wOA==');
    expect(history.truncated).toBe(false);
    expect(history.events.length).toBeGreaterThan(40);
    expect(history.events.map((event) => event.at)).toEqual([...history.events.map((event) => event.at)].sort());
  });

  it('marks the history truncated when a later page fails, keeping what was read', async () => {
    const [first] = split('custody-paged', 40);
    let calls = 0;
    const run: GhRunner = async () => {
      calls += 1;

      return calls === 1 ? { ok: true, value: first } : { ok: false, error: { kind: 'timed-out', message: 'timed out', remedy: 'Try again.' } };
    };
    const history = await historyOf(run, config(), { number: 15505, url: 'https://github.com/example-org/example-repo/issues/15505' });

    expect(history.truncated).toBe(true);
    expect(history.events.length).toBeGreaterThan(0);
  });

  it('skips status events from another project and from a custom status field', async () => {
    const otherProject = await historyOf(runnerOf(...pages('custody-issue')), config({ projectNumber: 4 }));
    const customField = await historyOf(runnerOf(...pages('custody-issue')), config({ statusField: 'Stage' }));

    expect(otherProject.events.every((event) => event.status === null)).toBe(true);
    expect(customField.events.every((event) => event.status === null)).toBe(true);
    expect(otherProject.events.length).toBeGreaterThan(0);
  });

  it('resolves linked accounts before the history leaves the source, so a linked bot is its person', async () => {
    const history = await historyOf(runnerOf(...pages('custody-issue')), config({ linkedAccounts: { 'bot-1': 'dev-5', 'dev-8': 'dev-1' } }));

    expect(history.events.some((event) => event.actor === 'bot-1')).toBe(false);
    expect(history.events.find((event) => event.at === '2026-08-27T03:09:04Z')?.actor).toBe('dev-5');
    expect(history.closedBy).toBe('dev-1');
  });

  it('reports a card whose URL names no repository as a bad response', async () => {
    const reading = await fetchCustody(config(), card({ url: 'not a url' }), runnerOf(), new AbortController().signal);

    expect(reading.history).toBeNull();
    expect(reading.failure).toMatchObject({ subject: 'github', kind: 'bad-response' });
  });

  it('passes a gh failure through with the source named', async () => {
    const run: GhRunner = async () => ({ ok: false, error: { kind: 'not-authenticated', message: 'gh is not logged in.', remedy: 'Run gh auth login.' } });
    const reading = await fetchCustody(config(), card(), run, new AbortController().signal);

    expect(reading).toEqual({ history: null, failure: { subject: 'github', kind: 'not-authenticated', message: 'gh is not logged in.', remedy: 'Run gh auth login.' } });
  });

  it('rejects a response of another shape and reports an absent issue as nothing found', async () => {
    const odd = await fetchCustody(config(), card(), runnerOf({ data: { repository: { issue: { number: 'x' } } } }), new AbortController().signal);
    const absent = await fetchCustody(config(), card(), runnerOf({ data: { repository: { issue: null } } }), new AbortController().signal);

    expect(odd.failure).toMatchObject({ kind: 'bad-response' });
    expect(absent).toEqual({ history: null, failure: null });
  });

  it('keeps the closer null for an open issue and ignores undated or null nodes', async () => {
    const page = structuredClone(pages('custody-issue')[0]) as Page & { data: { repository: { issue: { state: string; closedAt: string | null } } } };

    page.data.repository.issue.state = 'OPEN';
    page.data.repository.issue.closedAt = null;
    page.data.repository.issue.timelineItems.nodes.unshift(null, { __typename: 'AssignedEvent', actor: { login: 'dev-9' }, assignee: { login: 'dev-9' } });

    const history = await historyOf(runnerOf(page));

    expect(history.closedBy).toBeNull();
    expect(history.events).toHaveLength(20);
  });
});
