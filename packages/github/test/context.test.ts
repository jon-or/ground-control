import { describe, expect, it } from 'vitest';
import type { IssueCard, TriageContext } from '@ground-control/core';
import { clip, fetchCardContext, repositoryOfUrl } from '../src/context.js';
import type { GhRunner, Result } from '../src/index.js';
import { config, fixture } from './helpers.js';

function card(over: Partial<IssueCard> = {}): IssueCard {
  return {
    number: 19072,
    title: 'Listing sync retries a settled charge',
    type: 'Bug',
    typeColor: 'RED',
    url: 'https://github.com/example-org/example-repo/issues/19072',
    status: '⚒️ Dev',
    statusColor: 'BLUE',
    statusChangedAt: '2026-08-19T20:16:30Z',
    assignees: ['dev-1'],
    avatar: null,
    pullRequest: {
      number: 19077,
      url: 'https://github.com/example-org/example-repo/pull/19077',
      state: 'OPEN',
      author: 'dev-1-bot',
      isDraft: false,
      reviewDecision: 'REVIEW_REQUIRED',
    },
    updatedAt: '2026-08-19T20:16:30Z',
    ...over,
  };
}

/** Answers once with what it is given, and records what it was asked, so the query the board sends is assertable. */
function runnerOf(response: unknown): GhRunner & { calls: string[][]; options: unknown[] } {
  const calls: string[][] = [];
  const options: unknown[] = [];

  const run = (async (args: string[], opts?: unknown): Promise<Result<unknown>> => {
    calls.push(args);
    options.push(opts);

    return { ok: true, value: response };
  }) as GhRunner & { calls: string[][]; options: unknown[] };

  run.calls = calls;
  run.options = options;

  return run;
}

function failingRunner(error: { kind: string; message: string; remedy: string }): GhRunner {
  return async () => ({ ok: false, error }) as Result<unknown>;
}

async function contextOf(name: string, over: Partial<IssueCard> = {}, cfg = config()): Promise<TriageContext> {
  const reading = await fetchCardContext(cfg, card(over), runnerOf(fixture(name)), new AbortController().signal);

  expect(reading.failure).toBeNull();
  expect(reading.context).not.toBeNull();

  return reading.context!;
}

describe('reading a card context', () => {
  it('asks about the pull request the card is showing, and says when there is none', async () => {
    const withPr = runnerOf(fixture('context-review'));
    await fetchCardContext(config(), card(), withPr, new AbortController().signal);

    expect(withPr.calls[0]).toContain('issue=19072');
    expect(withPr.calls[0]).toContain('pr=19077');
    expect(withPr.calls[0]).toContain('withPr=true');

    const withoutPr = runnerOf(fixture('context-no-pr'));
    await fetchCardContext(config(), card({ number: 19231, pullRequest: null }), withoutPr, new AbortController().signal);

    expect(withoutPr.calls[0]).toContain('pr=0');
    expect(withoutPr.calls[0]).toContain('withPr=false');
  });

  it('reads the repository from the card own URL rather than from the configured one', async () => {
    const run = runnerOf(fixture('context-review'));
    await fetchCardContext(
      config({ repo: 'example-org/other-repo' }),
      card({ url: 'https://github.com/second-org/second-repo/issues/19072' }),
      run,
      new AbortController().signal,
    );

    expect(run.calls[0]).toContain('owner=second-org');
    expect(run.calls[0]).toContain('name=second-repo');
  });

  it('bounds the call, so a hung gh cannot hold a triage slot for the life of the hub', async () => {
    const run = runnerOf(fixture('context-review'));
    const controller = new AbortController();
    await fetchCardContext(config(), card(), run, controller.signal);

    expect(run.options[0]).toEqual({ timeoutMs: 20_000, signal: controller.signal });
  });

  it('carries the conversation in order, with who wrote each and what they are to the repository', async () => {
    const context = await contextOf('context-review');

    expect(context.issueNumber).toBe(19072);
    expect(context.status).toBe('⚒️ Dev');
    expect(context.logins).toEqual(['dev-1']);
    expect(context.comments.map((c) => c.author)).toEqual(['dev-2', 'dev-3', 'dev-2', 'dev-1', 'dev-3']);
    expect(context.comments.every((c) => c.authorAssociation === 'MEMBER')).toBe(true);
    expect(new Set(context.comments.map((c) => c.body)).size).toBe(5);
  });

  it('carries each author profile name beside their login, which is what a card calls them', async () => {
    const context = await contextOf('context-review');

    expect(context.comments.map((c) => c.authorName)).toEqual(
      ['dev-2 Surname', 'dev-3 Surname', 'dev-2 Surname', 'dev-1 Surname', 'dev-3 Surname'],
    );
    expect((await contextOf('context-review')).pullRequest?.authorName).toBe('dev-1-bot Surname');
  });

  it('reads a bot as having no name, and no relationship to the repository, rather than as an error', async () => {
    // A bot is not a `User`, so GitHub answers the profile fragment with nothing at all and the login has to stand
    // in. Every automated reviewer on a real pull request is one of these.
    const bots = await contextOf('context-bots', { number: 19131, pullRequest: { ...card().pullRequest!, number: 19143 } });
    const commented = bots.pullRequest!.comments;

    expect(commented.length).toBeGreaterThan(0);
    expect(commented.every((c) => c.authorName === null)).toBe(true);
    expect(commented.every((c) => c.author !== null)).toBe(true);
    expect(commented.every((c) => c.authorAssociation === 'NONE')).toBe(true);
    // And the same recording carries somebody who does have one, so this is not a fixture with no names in it.
    expect(bots.comments.some((c) => c.authorName !== null)).toBe(true);
  });

  it('keeps both ends of a long body and says what came out of the middle', async () => {
    const context = await contextOf('context-review');
    const recorded = (fixture('context-review') as { data: { repository: { issue: { body: string } } } }).data.repository
      .issue.body;

    // The recorder pads this one fixture past the limit, because no real body on the board happened to be long enough.
    expect(recorded.length).toBeGreaterThan(6_000);
    expect(context.body.startsWith(recorded.slice(0, 200))).toBe(true);
    expect(context.body.endsWith(recorded.slice(-200))).toBe(true);
    expect(context.body).toMatch(/\n\[…\d+ characters omitted…\]\n/);
    expect(context.comments.every((c) => !c.body.includes('omitted'))).toBe(true);
  });

  it('carries every fact the derived actions are read from', async () => {
    const pr = (await contextOf('context-review')).pullRequest;

    expect(pr).toMatchObject({
      number: 19077,
      state: 'OPEN',
      isDraft: false,
      author: 'dev-1-bot',
      reviewDecision: 'REVIEW_REQUIRED',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      checkState: 'SUCCESS',
    });
    expect(pr?.reviews).toEqual([
      { author: 'dev-4', authorName: null, state: 'COMMENTED', submittedAt: '2026-08-19T20:16:30Z' },
    ]);
    expect(pr?.threads).toHaveLength(1);
    expect(pr?.threads[0]?.isResolved).toBe(true);
    expect(pr?.threads[0]?.comments).toHaveLength(1);
  });

  it('reports no pull request for a card that has none, rather than an empty one', async () => {
    const context = await contextOf('context-no-pr', { number: 19231, pullRequest: null });

    expect(context.pullRequest).toBeNull();
    expect(context.comments).toHaveLength(2);
  });

  it('carries UNKNOWN mergeability through as read, which is what GitHub answers before it has computed', async () => {
    // Derived rather than recorded: GitHub computes mergeability on the first ask and answers UNKNOWN only in that
    // window, so a fixture of it cannot be produced on demand (`docs/mechanics.md` §31, `docs/testing.md`).
    const recorded = fixture('context-fresh') as { data: { repository: { pullRequest: Record<string, unknown> } } };
    recorded.data.repository.pullRequest['mergeable'] = 'UNKNOWN';
    recorded.data.repository.pullRequest['mergeStateStatus'] = 'UNKNOWN';

    const reading = await fetchCardContext(
      config(),
      card({ number: 19209, pullRequest: { ...card().pullRequest!, number: 19210 } }),
      runnerOf(recorded),
      new AbortController().signal,
    );

    expect(reading.context?.pullRequest?.mergeable).toBe('UNKNOWN');
    expect(reading.context?.pullRequest?.mergeStateStatus).toBe('UNKNOWN');
  });

  it('reports a null check rollup as no evidence, not as a failure', async () => {
    const recorded = fixture('context-review') as {
      data: { repository: { pullRequest: { commits: { nodes: { commit: { statusCheckRollup: unknown } }[] } } } };
    };
    recorded.data.repository.pullRequest.commits.nodes[0]!.commit.statusCheckRollup = null;

    const reading = await fetchCardContext(config(), card(), runnerOf(recorded), new AbortController().signal);

    expect(reading.context?.pullRequest?.checkState).toBeNull();
  });
});

describe('refusing a context it cannot read', () => {
  it('names a gh failure rather than throwing, and keeps its own subject', async () => {
    const reading = await fetchCardContext(
      config(),
      card(),
      failingRunner({ kind: 'not-authenticated', message: 'nope', remedy: 'log in' }),
      new AbortController().signal,
    );

    expect(reading.context).toBeNull();
    expect(reading.failure).toMatchObject({ subject: 'github', kind: 'not-authenticated' });
  });

  it('refuses an answer that is not the shape it reads', async () => {
    const reading = await fetchCardContext(config(), card(), runnerOf({ data: {} }), new AbortController().signal);

    expect(reading.context).toBeNull();
    expect(reading.failure).toMatchObject({ kind: 'bad-response' });
  });

  it('refuses a repository that has no issue by that number', async () => {
    const reading = await fetchCardContext(
      config(),
      card(),
      runnerOf({ data: { repository: { issue: null } } }),
      new AbortController().signal,
    );

    expect(reading.failure).toMatchObject({ kind: 'bad-response' });
  });

  it('refuses a card whose URL names no repository, rather than guessing one', async () => {
    const run = runnerOf(fixture('context-review'));
    const reading = await fetchCardContext(config(), card({ url: 'not-a-url' }), run, new AbortController().signal);

    expect(reading.failure).toMatchObject({ kind: 'bad-response' });
    expect(run.calls).toHaveLength(0);
  });
});

describe('the state changes on a card', () => {
  it('reads the status moves and assignments the board asked for, oldest first', async () => {
    // Recorded from a real hand-over: the status moved and the mover took themselves off it eight seconds later,
    // and somebody else put the developer on it two and a half hours after that (`docs/mechanics.md` §32).
    const events = (await contextOf('context-handover', { number: 19192, pullRequest: null })).stateEvents;

    expect(events.map((e) => [e.at, e.actor, e.status?.to ?? null, e.assigned, e.unassigned])).toEqual([
      ['2026-08-24T20:41:34Z', 'dev-4', '\u{1F195} New', null, null],
      ['2026-08-24T21:47:40Z', 'dev-3', null, 'dev-3', null],
      ['2026-08-24T21:47:42Z', 'dev-3', '\u{1F381} Assigned', null, null],
      ['2026-09-02T22:32:32Z', 'dev-3', '⚒️ Dev', null, null],
      ['2026-09-04T13:53:36Z', 'dev-3', '\u{1F50D} Dev Review', null, null],
      ['2026-09-04T13:53:44Z', 'dev-3', null, null, 'dev-3'],
      ['2026-09-04T16:28:42Z', 'dev-5', null, 'dev-1', null],
    ]);
  });

  it('carries where a move came from, since the last act on a card is often a bare assignment', async () => {
    const events = (await contextOf('context-handover', { number: 19192, pullRequest: null })).stateEvents;

    expect(events.find((e) => e.at === '2026-09-04T13:53:36Z')?.status).toEqual({
      from: '⚒️ Dev',
      to: '\u{1F50D} Dev Review',
    });
    // The card being added to the project, which is GitHub's own write and the one move nobody made.
    expect(events[0]?.status).toEqual({ from: '', to: '\u{1F195} New' });
  });

  it('ignores a status move on a project that is not the board’s own', async () => {
    // An issue sits on as many projects as anybody adds it to, and another team's column names say nothing here.
    const elsewhere = await contextOf('context-handover', { number: 19192, pullRequest: null }, config({ projectNumber: 99 }));

    expect(elsewhere.stateEvents.filter((e) => e.status !== null)).toEqual([]);
    expect(elsewhere.stateEvents.filter((e) => e.status === null)).toHaveLength(3);
  });

  it('drops a status cleared rather than reading it as a move to nowhere', async () => {
    // Derived: an item whose Status is emptied answers a null `status`, which the live API will not produce on
    // demand. An empty destination would print an arrow pointing at nothing, and the empty `from` already means
    // something else — the card being added to the board.
    const cleared = structuredClone(fixture('context-handover')) as {
      data: { repository: { issue: { timelineItems: { nodes: { __typename: string; status?: string | null }[] } } } };
    };

    for (const node of cleared.data.repository.issue.timelineItems.nodes) {
      if (node.__typename === 'ProjectV2ItemStatusChangedEvent') {
        node.status = null;
      }
    }

    const reading = await fetchCardContext(
      config(),
      card({ number: 19192, pullRequest: null }),
      runnerOf(cleared),
      new AbortController().signal,
    );

    expect(reading.context?.stateEvents.filter((e) => e.status !== null)).toEqual([]);
    expect(reading.context?.stateEvents).toHaveLength(3);
  });

  it('reads a card recorded before the timeline was asked for as having no state changes', async () => {
    expect((await contextOf('context-no-pr', { pullRequest: null })).stateEvents).toEqual([]);
  });
});

describe('the helpers the reader is built from', () => {
  it('reads owner and name out of a card URL, and refuses one that carries neither', () => {
    expect(repositoryOfUrl('https://github.com/example-org/example-repo/issues/1')).toEqual({
      owner: 'example-org',
      name: 'example-repo',
    });
    expect(repositoryOfUrl('https://github.com/example-org')).toBeNull();
    expect(repositoryOfUrl('')).toBeNull();
  });

  it('leaves short text alone, and trims what it is given', () => {
    expect(clip('short enough', 100)).toBe('short enough');
    expect(clip(null, 100)).toBe('');
    expect(clip('  padded  ', 100)).toBe('padded');
    expect(clip('x'.repeat(100), 100)).toBe('x'.repeat(100));
  });

  it('keeps the last line, because what a comment asks for is usually its last line', () => {
    const body = `Context first. ${'filler here. '.repeat(100)}Finally: please split this in two.`;
    const clipped = clip(body, 200);

    expect(clipped.startsWith('Context first.')).toBe(true);
    expect(clipped.endsWith('Finally: please split this in two.')).toBe(true);
  });

  it('says how much of the middle it took out, so nothing reads as the whole of what was written', () => {
    const body = `head ${'x '.repeat(500)}tail`;
    const clipped = clip(body, 100);
    const [before, rest] = clipped.split(`\n[…`);
    const [count, after] = (rest ?? '').split(` characters omitted…]\n`);

    // The marker rides on top of the limit: what is bounded is how much of the original text travels.
    expect(count).toMatch(/^\d+$/);
    expect(before!.length + after!.length).toBeLessThanOrEqual(100);
    expect(before!.length + after!.length + Number(count)).toBe(body.length);
  });

  it('cuts mid-token rather than throwing away most of the text, where there is no word boundary near', () => {
    const clipped = clip('c'.repeat(1_000), 100);

    expect(clipped.split(`\n[…`)[0]! + clipped.split(`…]\n`)[1]!).toBe('c'.repeat(100));
  });

  it('counts characters rather than bytes, which is what a body of emoji costs against the limit', () => {
    // Each of these is one code point and two UTF-16 code units, so ten of them spend twenty of the budget.
    expect(clip('🔥'.repeat(10), 20)).toBe('🔥'.repeat(10));
    expect(clip('🔥'.repeat(10), 19)).toContain('omitted');
  });
});
