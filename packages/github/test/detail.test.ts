import { describe, expect, it } from 'vitest';
import type { DetailEvent, DetailNote, DetailPost, IssueCard } from '@ground-control/core';
import { fetchDetail, itemAddress } from '../src/detail.js';
import type { GhRunner } from '../src/index.js';
import { config, fixture, runnerOf } from './helpers.js';

function card(over: Partial<IssueCard> = {}): IssueCard {
  return {
    number: 15619,
    title: 'Inbox badge fails silently on an empty result',
    type: 'Feature',
    typeColor: 'BLUE',
    url: 'https://github.com/example-org/example-repo/issues/15619',
    status: '⚒️ Dev',
    statusColor: 'BLUE',
    statusChangedAt: '2026-08-19T20:16:30Z',
    assignees: ['dev-1'],
    avatar: null,
    pullRequest: {
      number: 19572,
      url: 'https://github.com/example-org/example-repo/pull/19572',
      state: 'OPEN',
      author: 'dev-1',
      isDraft: false,
      reviewDecision: null,
      updatedAt: null,
      headOid: null,
      checksRed: null,
    },
    updatedAt: '2026-08-19T20:16:30Z',
    ...over,
  };
}

function failing(error: { kind: string; message: string; remedy: string }): GhRunner {
  return (async () => ({ ok: false, error })) as GhRunner;
}

/** Answer with something the schema cannot read, to separate a bad response from a missing subject. */
const malformed: GhRunner = (async () => ({ ok: true, value: { data: { repository: { issue: { number: 'no' } } } } })) as GhRunner;

const posts = (events: DetailEvent[]): DetailPost[] => events.filter((event): event is DetailPost => event.kind === 'comment' || event.kind === 'review');
const notes = (events: DetailEvent[]): DetailNote[] => events.filter((event): event is DetailNote => event.kind === 'note' || event.kind === 'commit');

const readIssue = () => fetchDetail(config(), 'example-org', 'example-repo', 15619, 'issue', runnerOf(fixture('detail-issue')));
const readPull = () => fetchDetail(config(), 'example-org', 'example-repo', 19572, 'pull-request', runnerOf(fixture('detail-pull-request')));

/** Build a timeline response around one item, for shapes a recording cannot produce on demand. */
function response(over: Record<string, unknown>, subject: 'issue' | 'pullRequest' = 'pullRequest'): unknown {
  return {
    data: {
      repository: {
        nameWithOwner: 'example-org/example-repo',
        [subject]: {
          number: 19572,
          title: 'Composed',
          url: 'https://github.com/example-org/example-repo/pull/19572',
          state: 'OPEN',
          createdAt: '2026-09-01T00:00:00Z',
          bodyHTML: '<p>body</p>',
          lastEditedAt: null,
          author: { login: 'dev-1', avatarUrl: null },
          reactionGroups: [],
          assignees: { nodes: [] },
          milestone: null,
          labels: { nodes: [] },
          timelineItems: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
          ...over,
        },
      },
    },
  };
}

function page(nodes: unknown[], hasPreviousPage = false, startCursor: string | null = null): unknown {
  return { pageInfo: { hasPreviousPage, startCursor }, nodes };
}

/** One timeline node of the given type, with whatever fields that type carries. */
function event(typename: string, over: Record<string, unknown> = {}): unknown {
  return { __typename: typename, createdAt: '2026-09-01T00:00:00Z', actor: { login: 'dev-2', avatarUrl: null }, ...over };
}

const reference = (number: number, repo: string) => ({
  number,
  url: `https://github.com/${repo}/issues/${number}`,
  repository: { nameWithOwner: repo },
});

/** Read the summaries a timeline of composed events produces. */
async function summaries(nodes: unknown[], subject: 'issue' | 'pull-request' = 'pull-request'): Promise<string[]> {
  const reading = await fetchDetail(
    config(),
    'example-org',
    'example-repo',
    19572,
    subject,
    runnerOf(response({ timelineItems: page(nodes) }, subject === 'issue' ? 'issue' : 'pullRequest')),
  );

  return notes(reading.detail?.events ?? []).map((note) => note.summary);
}

function threadNode(path: string, line: number, review: string | null = null, over: Record<string, unknown> = {}): unknown {
  return {
    path,
    line: line === 0 ? null : line,
    originalLine: line === 0 ? null : line,
    isResolved: false,
    isOutdated: false,
    comments: {
      pageInfo: { hasPreviousPage: false },
      nodes: [
        {
          bodyHTML: '<p>note</p>',
          createdAt: '2026-09-01T00:00:00Z',
          lastEditedAt: null,
          isMinimized: false,
          minimizedReason: null,
          author: { login: 'dev-2', avatarUrl: null },
          reactionGroups: [],
          pullRequestReview: review === null ? null : { id: review },
        },
      ],
      ...over,
    },
  };
}

describe('reading one conversation for display', () => {
  it('carries the source-rendered body rather than markdown a client would have to parse', async () => {
    const reading = await readIssue();

    expect(reading.failure).toBeNull();
    expect(reading.detail?.bodyHtml).toContain('<table');
    expect(reading.detail?.bodyHtml).toContain('task-list-item-checkbox');
    // Nothing in the pipeline turns markdown into HTML; the source already did.
    expect(reading.detail?.bodyHtml.startsWith('#')).toBe(false);
  });

  it('names the subject, repository, and address the panel shows', async () => {
    const reading = await readIssue();

    expect(reading.detail).toMatchObject({
      subject: 'issue',
      number: 15619,
      repository: 'example-org/example-repo',
      state: 'CLOSED',
      url: 'https://github.com/example-org/example-repo/issues/15619',
    });
  });

  it('reads comments and state changes into one timeline, in the order they happened', async () => {
    const reading = await readIssue();
    const events = reading.detail?.events ?? [];

    expect(events.length).toBeGreaterThan(20);
    expect(posts(events).length).toBeGreaterThan(0);
    expect(notes(events).length).toBeGreaterThan(0);

    const times = events.map((event) => Date.parse(event.createdAt));

    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('words each kind of state change rather than naming its API type', async () => {
    const reading = await readIssue();
    const said = notes(reading.detail?.events ?? []).map((note) => note.summary);

    expect(said).toContain('assigned dev-3');
    expect(said).toContain('added the area-1 label');
    expect(said).toContain('set the status to 🆕 New');
    expect(said).toContain('unassigned dev-5');
    expect(said.some((line) => line.startsWith('renamed this to '))).toBe(true);
    expect(said.some((line) => line.startsWith('referenced this in commit '))).toBe(true);
    // No summary should leak a GraphQL type name into what a reader sees.
    expect(said.some((line) => line.includes('Event'))).toBe(false);
  });

  it('keeps every comment author and body the source returned', async () => {
    const reading = await readIssue();

    for (const post of posts(reading.detail?.events ?? [])) {
      expect(post.author).toMatch(/^dev-\d+$/);
      expect(post.bodyHtml.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(post.createdAt))).toBe(false);
    }
  });

  it('carries reactions people left and drops the emoji nobody used', async () => {
    const reading = await readIssue();
    const reacted = posts(reading.detail?.events ?? []).flatMap((post) => post.reactions);

    expect(reacted).toContainEqual({ content: 'THUMBS_UP', count: 1 });
    expect(reacted).toContainEqual({ content: 'HOORAY', count: 3 });
    // GitHub returns all eight groups on every comment; only the ones someone used are carried.
    expect(reacted.every((reaction) => reaction.count > 0)).toBe(true);
  });

  it('reports a clipped conversation from the page cursor, not from a total the connection overcounts', async () => {
    const clipped = await readIssue();

    expect(clipped.detail?.moreEvents).toBe(true);

    // This recording holds every timeline entry GitHub returned, so nothing claims the conversation is short.
    const whole = await readPull();

    expect(whole.detail?.moreEvents).toBe(false);
    // Its threads were trimmed when recorded, which is what a clipped thread list reports.
    expect(whole.detail?.moreThreads).toBe(true);
  });

  it('hangs each review thread off the review that opened it', async () => {
    const reading = await readPull();
    const reviews = posts(reading.detail?.events ?? []).filter((post) => post.kind === 'review');

    expect(reviews).toHaveLength(5);
    expect(reviews.every((review) => review.state === 'COMMENTED')).toBe(true);
    expect(reviews.reduce((count, review) => count + review.threads.length, 0)).toBe(3);
    // Every thread found its review, so none is left to the trailing list.
    expect(reading.detail?.threads).toEqual([]);
  });

  it('lists a thread apart when the review that opened it is not in the timeline', async () => {
    const reading = await fetchDetail(
      config(),
      'example-org',
      'example-repo',
      19572,
      'pull-request',
      runnerOf(response({ reviewThreads: page([threadNode('src/a.ts', 3, 'PRR_missing')]) })),
    );

    expect(reading.detail?.threads).toHaveLength(1);
    expect(reading.detail?.threads[0]?.path).toBe('src/a.ts');
  });

  it('orders threads by file then line, which is not the order the source returns', async () => {
    const reading = await fetchDetail(
      config(),
      'example-org',
      'example-repo',
      19572,
      'pull-request',
      runnerOf(response({ reviewThreads: page([threadNode('src/b.ts', 4), threadNode('src/a.ts', 90), threadNode('src/a.ts', 9)]) })),
    );

    expect(reading.detail?.threads.map((thread) => `${thread.path}:${thread.line}`)).toEqual(['src/a.ts:9', 'src/a.ts:90', 'src/b.ts:4']);
  });

  it('reads a thread whose diff moved past it through its original line', async () => {
    const reading = await readPull();
    const threads = posts(reading.detail?.events ?? []).flatMap((post) => post.threads);
    const outdated = threads.find((thread) => thread.outdated);

    expect(outdated?.line).toBe(2058);
  });

  it('pages review threads separately, so a second timeline page does not refetch them', async () => {
    const first = response({ reviewThreads: page([threadNode('src/a.ts', 1, 'PRR_1')], true, 'THR1') });
    const second = { data: { repository: { pullRequest: { reviewThreads: page([threadNode('src/b.ts', 2, 'PRR_1')]) } } } };
    const runner = runnerOf(first, second);
    const reading = await fetchDetail(config(), 'example-org', 'example-repo', 19572, 'pull-request', runner);

    expect(runner.calls[1]).toContain('threads=THR1');
    expect(runner.calls[1]?.some((arg) => arg.startsWith('events='))).toBe(false);
    expect(reading.detail?.threads).toHaveLength(2);
  });

  it('carries a hidden comment with the reason the source hid it, rather than dropping it', async () => {
    const reading = await fetchDetail(
      config(),
      'example-org',
      'example-repo',
      19572,
      'pull-request',
      runnerOf(
        response({
          timelineItems: page([
            {
              __typename: 'IssueComment',
              createdAt: '2026-09-01T00:00:00Z',
              bodyHTML: '<p>off topic</p>',
              author: { login: 'dev-2', avatarUrl: null },
              isMinimized: true,
              minimizedReason: 'OFF_TOPIC',
              reactionGroups: [],
            },
          ]),
        }),
      ),
    );

    expect(posts(reading.detail?.events ?? [])[0]).toMatchObject({ hidden: 'OFF_TOPIC', bodyHtml: '<p>off topic</p>' });
  });

  it('reads a commit as who wrote it and what it says', async () => {
    const reading = await readPull();
    const commits = notes(reading.detail?.events ?? []).filter((note) => note.kind === 'commit');

    expect(commits).toHaveLength(2);
    expect(commits[0]?.summary).toMatch(/^[0-9a-f]{7} \S/);
    expect(commits[0]?.actor).toMatch(/^dev-\d+$/);
  });

  it('carries the pull-request facts the header shows beside the conversation', async () => {
    const reading = await readPull();

    expect(reading.detail).toMatchObject({
      branches: { base: 'main', head: 'topic-branch' },
      draft: false,
      reviewDecision: 'REVIEW_REQUIRED',
      checks: 'SUCCESS',
    });
  });

  it('carries the issue facts the header shows, and leaves pull-request facts empty', async () => {
    const reading = await readIssue();

    expect(reading.detail?.milestone).toBe('Patch 1');
    expect(reading.detail?.branches).toBeNull();
    expect(reading.detail?.checks).toBeNull();
    expect(reading.detail?.reviewDecision).toBeNull();
  });

  it('leaves an issue without review threads rather than inventing an empty section', async () => {
    const reading = await readIssue();

    expect(reading.detail?.threads).toEqual([]);
    expect(reading.detail?.moreThreads).toBe(false);
  });

  it('keeps a later page failure from failing the read, and still says the conversation is clipped', async () => {
    let call = 0;
    const first = response({ timelineItems: page([event('ReopenedEvent')], true, 'OLDER') });
    const runner = (async () => {
      call += 1;

      return call === 1
        ? { ok: true, value: first }
        : { ok: false, error: { kind: 'offline', message: 'GitHub could not be reached.', remedy: 'Check your connection.' } };
    }) as GhRunner;
    const reading = await fetchDetail(config(), 'example-org', 'example-repo', 19572, 'pull-request', runner);

    expect(reading.failure).toBeNull();
    expect(reading.detail?.events).toHaveLength(1);
    expect(reading.detail?.moreEvents).toBe(true);
  });

  it('asks for the subject it was given and nothing else', async () => {
    const runner = runnerOf(fixture('detail-pull-request'));
    await fetchDetail(config(), 'example-org', 'example-repo', 19572, 'pull-request', runner);

    const args = runner.calls[0] ?? [];

    expect(args).toContain('issue=false');
    expect(args).toContain('pr=true');
    expect(args).toContain('number=19572');
  });

  it('bounds the read so a slow source cannot hold the request open', async () => {
    const runner = runnerOf(fixture('detail-issue'));
    await fetchDetail(config(), 'example-org', 'example-repo', 15619, 'issue', runner);

    expect(runner.bounds[0]?.timeoutMs).toBeGreaterThan(0);
  });

  it('reports a source failure with its remedy instead of an empty conversation', async () => {
    const reading = await fetchDetail(
      config(),
      'example-org',
      'example-repo',
      15619,
      'issue',
      failing({ kind: 'offline', message: 'GitHub could not be reached.', remedy: 'Check your connection.' }),
    );

    expect(reading.detail).toBeNull();
    expect(reading.failure).toEqual({ message: 'GitHub could not be reached.', remedy: 'Check your connection.' });
  });

  it('separates a response it cannot read from a subject that is not there', async () => {
    const unreadable = await fetchDetail(config(), 'example-org', 'example-repo', 15619, 'issue', malformed);

    expect(unreadable.detail).toBeNull();
    expect(unreadable.failure?.message).toContain('unexpected response');

    const absent = await fetchDetail(
      config(),
      'example-org',
      'example-repo',
      15619,
      'issue',
      runnerOf({ data: { repository: { nameWithOwner: 'example-org/example-repo', issue: null } } }),
    );

    expect(absent.detail).toBeNull();
    expect(absent.failure).toBeNull();
  });

  it('reads the newest entries first, so a conversation that will not fit loses its oldest, never its latest', async () => {
    const runner = runnerOf(
      response({ timelineItems: page([event('ReopenedEvent')], true, 'OLDER') }),
      { data: { repository: { pullRequest: { timelineItems: page([event('ClosedEvent', { createdAt: '2026-08-01T00:00:00Z' })]) } } } },
    );
    const reading = await fetchDetail(config(), 'example-org', 'example-repo', 19572, 'pull-request', runner);

    // The page read second holds older entries, so it belongs in front of the first, not after it.
    expect(notes(reading.detail?.events ?? []).map((note) => note.summary)).toEqual(['closed this', 'reopened this']);
    expect(runner.calls[1]).toContain('events=OLDER');
  });

  it('stops at its page limit and says the conversation is clipped, rather than reading without bound', async () => {
    const runner = runnerOf(
      response({ timelineItems: page([event('ReopenedEvent')], true, 'MORE') }),
      ...Array.from({ length: 40 }, () => ({
        data: { repository: { pullRequest: { timelineItems: page([event('ClosedEvent')], true, 'MORE') } } },
      })),
    );
    const reading = await fetchDetail(config(), 'example-org', 'example-repo', 19572, 'pull-request', runner);

    expect(runner.calls).toHaveLength(20);
    expect(reading.detail?.moreEvents).toBe(true);
  });

  it('stops paging when the source says there is more but names no cursor', async () => {
    const runner = runnerOf(response({ timelineItems: page([event('ReopenedEvent')], true, null) }));
    const reading = await fetchDetail(config(), 'example-org', 'example-repo', 19572, 'pull-request', runner);

    expect(runner.calls).toHaveLength(1);
    expect(reading.detail?.moreEvents).toBe(true);
  });

  it('stops at its thread page limit as well', async () => {
    const runner = runnerOf(
      response({ reviewThreads: page([threadNode('src/a.ts', 1)], true, 'MORE') }),
      ...Array.from({ length: 10 }, () => ({
        data: { repository: { pullRequest: { reviewThreads: page([threadNode('src/b.ts', 2)], true, 'MORE') } } },
      })),
    );
    const reading = await fetchDetail(config(), 'example-org', 'example-repo', 19572, 'pull-request', runner);

    expect(runner.calls).toHaveLength(5);
    expect(reading.detail?.moreThreads).toBe(true);
  });

  it('keeps a thread page it cannot read from failing the whole conversation', async () => {
    const runner = runnerOf(
      response({ reviewThreads: page([threadNode('src/a.ts', 1)], true, 'MORE') }),
      { data: { repository: { pullRequest: null } } },
    );
    const reading = await fetchDetail(config(), 'example-org', 'example-repo', 19572, 'pull-request', runner);

    expect(reading.failure).toBeNull();
    expect(reading.detail?.threads).toHaveLength(1);
    expect(reading.detail?.moreThreads).toBe(true);
  });

  it('passes the caller\'s cancellation to the source rather than reading past it', async () => {
    const runner = runnerOf(fixture('detail-issue'));
    const abort = new AbortController();
    await fetchDetail(config(), 'example-org', 'example-repo', 15619, 'issue', runner, abort.signal);

    expect(runner.bounds[0]?.signal).toBe(abort.signal);
  });

  it('drops a node it has no reading for instead of failing or inventing one', async () => {
    const reading = await fetchDetail(
      config(),
      'example-org',
      'example-repo',
      19572,
      'pull-request',
      runnerOf(response({ timelineItems: page([null, event('PinnedEvent'), event('ReopenedEvent')]) })),
    );

    expect(reading.failure).toBeNull();
    expect(reading.detail?.events).toHaveLength(1);
  });

  it('words every state change it reads, without leaking an enum or a type name', async () => {
    const said = await summaries([
      event('ClosedEvent', { stateReason: 'NOT_PLANNED' }),
      event('ReopenedEvent'),
      event('MergedEvent', { mergeRefName: 'main' }),
      event('LabeledEvent', { label: { name: 'bug' } }),
      event('UnlabeledEvent', { label: { name: 'bug' } }),
      event('AssignedEvent', { assignee: { login: 'dev-3' } }),
      event('UnassignedEvent', { assignee: { login: 'dev-3' } }),
      event('MilestonedEvent', { milestoneTitle: 'Patch 1' }),
      event('DemilestonedEvent', { milestoneTitle: 'Patch 1' }),
      event('RenamedTitleEvent', { previousTitle: 'Old', currentTitle: 'New' }),
      event('ReviewRequestedEvent', { requestedReviewer: { login: 'dev-4' } }),
      event('ReviewRequestRemovedEvent', { requestedReviewer: { slug: 'platform' } }),
      event('ReviewDismissedEvent', { dismissalMessage: 'stale' }),
      event('HeadRefForcePushedEvent', { beforeCommit: { abbreviatedOid: 'aaa1111' }, afterCommit: { abbreviatedOid: 'bbb2222' } }),
      event('HeadRefDeletedEvent', { headRefName: 'topic' }),
      event('HeadRefRestoredEvent'),
      event('BaseRefChangedEvent', { previousRefName: 'main', currentRefName: 'release' }),
      event('ReadyForReviewEvent'),
      event('ConvertToDraftEvent'),
      event('LockedEvent', { lockReason: 'TOO_HEATED' }),
      event('UnlockedEvent'),
      event('UnmarkedAsDuplicateEvent'),
      event('ProjectV2ItemStatusChangedEvent', { previousStatus: 'Dev', status: 'Review' }),
      event('TransferredEvent', { fromRepository: { nameWithOwner: 'other-org/other-repo' } }),
    ]);

    expect(said).toEqual([
      'closed this as not planned',
      'reopened this',
      'merged this into main',
      'added the bug label',
      'removed the bug label',
      'assigned dev-3',
      'unassigned dev-3',
      'added this to the Patch 1 milestone',
      'removed this from the Patch 1 milestone',
      'renamed this to New',
      'requested a review from dev-4',
      'removed the review request for platform',
      'dismissed a review: stale',
      'force-pushed from aaa1111 to bbb2222',
      'deleted the topic branch',
      'restored the head branch',
      'changed the base from main to release',
      'marked this ready for review',
      'converted this to a draft',
      // Every underscore is read, not only the first.
      'locked this as too heated',
      'unlocked this',
      'removed the duplicate mark',
      'moved this from Dev to Review',
      'transferred this from other-org/other-repo',
    ]);
  });

  it('names another repository when it references one, and stays bare within this one', async () => {
    const said = await summaries([
      event('CrossReferencedEvent', { source: reference(7, 'example-org/example-repo') }),
      event('CrossReferencedEvent', { source: reference(7, 'other-org/other-repo') }),
      event('ConnectedEvent', { subject: reference(8, 'example-org/example-repo') }),
      event('DisconnectedEvent', { subject: reference(8, 'other-org/other-repo') }),
      event('MarkedAsDuplicateEvent', { canonical: reference(9, 'other-org/other-repo') }),
    ]);

    expect(said).toEqual([
      'referenced this in #7',
      'referenced this in other-org/other-repo#7',
      'linked #8',
      'unlinked other-org/other-repo#8',
      'marked this a duplicate of other-org/other-repo#9',
    ]);
  });

  it('reads a state change whose optional parts the source left out, without composing a dangling sentence', async () => {
    const said = await summaries([
      event('ClosedEvent', { stateReason: null }),
      event('LockedEvent', { lockReason: null }),
      event('ReferencedEvent', { commit: null }),
      event('AssignedEvent', { assignee: null }),
      event('ProjectV2ItemStatusChangedEvent', { previousStatus: null, status: 'Dev' }),
      event('MergedEvent', { mergeRefName: null }),
      event('ReviewDismissedEvent', { dismissalMessage: null }),
    ]);

    expect(said).toEqual([
      'closed this',
      'locked this',
      'referenced this in commit an unreadable commit',
      'assigned someone',
      'set the status to Dev',
      'merged this into the base branch',
      'dismissed a review',
    ]);
    // No summary trails off where a field was absent.
    expect(said.every((line) => line.trim() === line && line.length > 0)).toBe(true);
  });

  it('links a note to what it names, and refuses an address the editor must not open', async () => {
    const reading = await fetchDetail(
      config(),
      'example-org',
      'example-repo',
      19572,
      'pull-request',
      runnerOf(
        response({
          timelineItems: page([
            event('ConnectedEvent', { subject: { number: 8, url: 'https://github.com/other-org/other-repo/issues/8', repository: { nameWithOwner: 'other-org/other-repo' } } }),
          ]),
        }),
      ),
    );

    expect(notes(reading.detail?.events ?? [])[0]?.url).toBe('https://github.com/other-org/other-repo/issues/8');
  });

  it('carries a hidden review reply with its reason, as the conversation does', async () => {
    const reading = await fetchDetail(
      config(),
      'example-org',
      'example-repo',
      19572,
      'pull-request',
      runnerOf(
        response({
          reviewThreads: page([
            threadNode('src/a.ts', 1, null, {
              nodes: [
                {
                  bodyHTML: '<p>spam</p>',
                  createdAt: '2026-09-01T00:00:00Z',
                  lastEditedAt: null,
                  isMinimized: true,
                  minimizedReason: 'SPAM',
                  author: { login: 'dev-2', avatarUrl: null },
                  reactionGroups: [],
                  pullRequestReview: null,
                },
              ],
            }),
          ]),
        }),
      ),
    );

    expect(reading.detail?.threads[0]?.comments[0]?.hidden).toBe('SPAM');
  });

  it('reports a clipped thread from its cursor, not from a count', async () => {
    const reading = await fetchDetail(
      config(),
      'example-org',
      'example-repo',
      19572,
      'pull-request',
      runnerOf(response({ reviewThreads: page([threadNode('src/a.ts', 1, null, { pageInfo: { hasPreviousPage: true } })]) })),
    );

    expect(reading.detail?.threads[0]?.moreComments).toBe(true);
    expect(reading.detail?.threads[0]?.comments).toHaveLength(1);
  });

  it('reads both recordings through the shipped schemas, so a drift from GitHub fails here', async () => {
    for (const [name, number, subject] of [
      ['detail-issue', 15619, 'issue'],
      ['detail-pull-request', 19572, 'pull-request'],
    ] as const) {
      const reading = await fetchDetail(config(), 'example-org', 'example-repo', number, subject, runnerOf(fixture(name)));

      expect(reading.failure, `${name} did not parse`).toBeNull();
      expect(reading.detail?.events.length, `${name} carried no events`).toBeGreaterThan(0);
    }
  });

  it('pages an issue timeline through the issue branch of the response, not the pull-request one', async () => {
    const runner = runnerOf(
      response({ timelineItems: page([event('ReopenedEvent')], true, 'OLDER') }, 'issue'),
      { data: { repository: { issue: { timelineItems: page([event('ClosedEvent', { createdAt: '2026-08-01T00:00:00Z' })]) } } } },
    );
    const reading = await fetchDetail(config(), 'example-org', 'example-repo', 15619, 'issue', runner);

    expect(notes(reading.detail?.events ?? []).map((note) => note.summary)).toEqual(['closed this', 'reopened this']);
    expect(reading.detail?.moreEvents).toBe(false);
  });

  it('reads an item whose optional parts the source returned as null', async () => {
    const reading = await fetchDetail(
      config(),
      'example-org',
      'example-repo',
      19572,
      'pull-request',
      runnerOf(
        response({
          author: null,
          labels: null,
          assignees: null,
          milestone: null,
          reactionGroups: null,
          reviewThreads: page([threadNode('src/b.ts', 0), threadNode('src/a.ts', 0)]),
        }),
      ),
    );

    expect(reading.detail).toMatchObject({ author: null, authorAvatarUrl: null, labels: [], assignees: [], milestone: null, reactions: [] });
    // A thread the source gives no line for still sorts, by file alone.
    expect(reading.detail?.threads.map((thread) => thread.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('reads nothing from a repository it cannot see', async () => {
    const reading = await fetchDetail(config(), 'example-org', 'example-repo', 15619, 'issue', runnerOf({ data: { repository: null } }));

    expect(reading.detail).toBeNull();
    expect(reading.failure).toBeNull();
  });
});

describe('resolving which item a card points at', () => {
  it('reads the owner and name from the card URL rather than the configured repository', () => {
    expect(itemAddress(card({ url: 'https://github.com/other-org/other-repo/issues/7', number: 7 }), 'issue')).toEqual({
      owner: 'other-org',
      name: 'other-repo',
      number: 7,
    });
  });

  it('addresses the pull request the card already selected', () => {
    expect(itemAddress(card(), 'pull-request')).toEqual({ owner: 'example-org', name: 'example-repo', number: 19572 });
  });

  it('reads a closing pull request from its own repository, not the issue’s', () => {
    // closedByPullRequestsReferences returns pull requests from other repositories, where the same number is
    // a different item.
    const crossRepo = card({
      pullRequest: { ...card().pullRequest!, url: 'https://github.com/other-org/other-repo/pull/42', number: 42 },
    });

    expect(itemAddress(crossRepo, 'pull-request')).toEqual({ owner: 'other-org', name: 'other-repo', number: 42 });
    expect(itemAddress(crossRepo, 'issue')).toMatchObject({ owner: 'example-org', name: 'example-repo' });
  });

  it('refuses a pull request whose address is not a github.com one', () => {
    const elsewhere = card({
      pullRequest: { ...card().pullRequest!, url: 'https://ghe.example.com/example-org/example-repo/pull/1' },
    });

    expect(itemAddress(elsewhere, 'pull-request')).toBeNull();
  });

  it('refuses a card with no pull request, so the panel never asks for one', () => {
    expect(itemAddress(card({ pullRequest: null }), 'pull-request')).toBeNull();
  });

  it('refuses a URL that is not a github.com item', () => {
    expect(itemAddress(card({ url: 'https://ghe.example.com/example-org/example-repo/issues/1' }), 'issue')).toBeNull();
  });
});
