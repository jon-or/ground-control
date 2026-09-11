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
      updatedAt: null,
      headOid: null,
      checksRed: null,
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
  it('requests the displayed PR and omits absent PRs', async () => {
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

  it('uses the repository from the card URL', async () => {
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
    // Bots do not resolve the User profile fragment; fall back to login.
    const bots = await contextOf('context-bots', { number: 19131, pullRequest: { ...card().pullRequest!, number: 19143 } });
    const commented = bots.pullRequest!.comments;

    expect(commented.length).toBeGreaterThan(0);
    expect(commented.every((c) => c.authorName === null)).toBe(true);
    expect(commented.every((c) => c.author !== null)).toBe(true);
    expect(commented.every((c) => c.authorAssociation === 'NONE')).toBe(true);
    // And the same recording carries somebody who does have one, so this is not a fixture with no names in it.
    expect(bots.comments.some((c) => c.authorName !== null)).toBe(true);
  });

  it('retains both ends of long bodies with an omission count', async () => {
    const context = await contextOf('context-review');
    const recorded = (fixture('context-review') as { data: { repository: { issue: { body: string } } } }).data.repository
      .issue.body;

    // Use the recorder-generated long body to exercise clipping.
    expect(recorded.length).toBeGreaterThan(6_000);
    expect(context.body.startsWith(recorded.slice(0, 200))).toBe(true);
    expect(context.body.endsWith(recorded.slice(-200))).toBe(true);
    expect(context.body).toMatch(/\n\[…\d+ characters omitted…\]\n/);
    expect(context.comments.every((c) => !c.body.includes('omitted'))).toBe(true);
  });

  it('carries every fact the derived action and a merge plan are read from', async () => {
    const pr = (await contextOf('context-review')).pullRequest;

    expect(pr).toMatchObject({
      number: 19077,
      state: 'OPEN',
      isDraft: false,
      author: 'dev-1-bot',
      checkState: 'SUCCESS',
    });
    expect(pr?.reviews).toEqual([
      { author: 'dev-8', authorName: null, state: 'COMMENTED', submittedAt: '2026-08-19T20:16:30Z' },
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

  /** What decides whether keeping a branch current is one merge or a chain of them (R39). */
  it('carries the branches a merge would be between, and the one the repository merges into', async () => {
    const context = await contextOf('context-review');

    expect(context.defaultBranch).toBe('master');
    expect(context.repository).toBe('example-org/example-repo');
    expect(context.pullRequest).toMatchObject({
      baseRefName: 'master',
      headRefName: '19072-calendar-feed-counts-archived-records-twice',
      headOid: '5886b444997bada42bd47b6afcf95d83830fc2ac',
    });
  });

  /** A recorded pull request that really is stacked on another feature branch, which is the case the board refuses. */
  it('reads a base that is not the default branch as what it is', async () => {
    const context = await contextOf('context-bots', { number: 19131, pullRequest: { ...card().pullRequest!, number: 19143 } });

    expect(context.defaultBranch).toBe('master');
    expect(context.pullRequest?.baseRefName).toBe('19175-inbox-badge-overwrites-a-manual-edit');
    expect(context.pullRequest?.baseRefName).not.toBe(context.defaultBranch);
  });

  it('reports no default branch rather than assuming one, where GitHub named none', async () => {
    const recorded = fixture('context-review') as { data: { repository: Record<string, unknown> } };
    recorded.data.repository['defaultBranchRef'] = null;

    const reading = await fetchCardContext(config(), card(), runnerOf(recorded), new AbortController().signal);

    expect(reading.context?.defaultBranch).toBeNull();
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

/** A linked account reads as its target everywhere the prompt would name it, and counts among the developer's logins (R28). */
describe('reading a card context with a linked account', () => {
  const PROFILE = { login: 'dev-1', name: 'dev-1 Surname', avatarUrl: 'https://avatars.githubusercontent.com/dev-1?s=40' };
  const linked = (target: string, logins = ['dev-1-bot'], profiles = new Map([['dev-1', { profile: PROFILE, at: 0 }]])) =>
    config({ logins, linkedAccounts: { 'dev-1-bot': target }, profiles });

  it('shows the bot pull request as the developer’s, with the developer’s profile name, and folds the bot into the developer logins', async () => {
    const context = await contextOf('context-review', {}, linked('dev-1'));

    expect(context.pullRequest).toMatchObject({ author: 'dev-1', authorName: 'dev-1 Surname' });
    expect(context.logins).toEqual(['dev-1']);
    // The bot assigned the developer, and was later assigned and unassigned itself: every one of those reads as dev-1.
    expect(context.stateEvents.slice(0, 1)).toEqual([{ at: '2026-08-19T18:47:25Z', actor: 'dev-1', actorName: 'dev-1 Surname', status: null, assigned: 'dev-1', unassigned: null }]);
    expect(context.stateEvents.filter((event) => event.assigned === 'dev-1-bot' || event.unassigned === 'dev-1-bot')).toHaveLength(0);
    expect(context.stateEvents.filter((event) => event.assigned === 'dev-1' || event.unassigned === 'dev-1')).toHaveLength(7);
    // The other people keep their own names.
    expect(context.comments.map((c) => c.authorName)).toEqual(['dev-2 Surname', 'dev-3 Surname', 'dev-2 Surname', 'dev-1 Surname', 'dev-3 Surname']);
  });

  it('takes the target’s profile name over the bot’s own, and the bare target login while the profile is unread', async () => {
    const colleague = await contextOf('context-review', {}, linked('dev-2', ['dev-1'], new Map([['dev-2', { profile: { login: 'dev-2', name: 'Two Surname', avatarUrl: '' }, at: 0 }]])));
    const unread = await contextOf('context-review', {}, linked('dev-2', ['dev-1'], new Map()));

    expect(colleague.pullRequest).toMatchObject({ author: 'dev-2', authorName: 'Two Surname' });
    expect(colleague.logins).toEqual(['dev-1']);
    expect(unread.pullRequest).toMatchObject({ author: 'dev-2', authorName: null });
  });

  it('asks for a review from the developer once when both the bot and the developer were asked', async () => {
    const recorded = structuredClone(fixture('context-review')) as { data: { repository: { pullRequest: { reviewRequests: { nodes: unknown[] } } } } };

    // Derived: the recording has no review requests; both accounts are in it elsewhere.
    recorded.data.repository.pullRequest.reviewRequests.nodes = [
      { requestedReviewer: { login: 'dev-1-bot' } },
      { requestedReviewer: { login: 'dev-1', name: 'dev-1 Surname' } },
      { requestedReviewer: { slug: 'platform' } },
    ];
    const reading = await fetchCardContext(linked('dev-1'), card(), runnerOf(recorded), new AbortController().signal);

    expect(reading.context?.pullRequest?.reviewRequests).toEqual([{ login: 'dev-1', name: 'dev-1 Surname' }, { login: 'platform', name: null }]);
  });

  it('lists each developer login once when an alias and its target are both configured', async () => {
    const context = await contextOf('context-review', {}, linked('dev-1', ['dev-1', 'DEV-1-BOT']));

    expect(context.logins).toEqual(['dev-1']);
  });
});

describe('refusing a context it cannot read', () => {
  it('returns gh failures with the GitHub source ID', async () => {
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
    // Recorded status change, actor unassignment eight seconds later, and developer assignment 2.5 hours later (M32).
    const events = (await contextOf('context-handover', { number: 19192, pullRequest: null })).stateEvents;

    expect(events.map((e) => [e.at, e.actor, e.status?.to ?? null, e.assigned, e.unassigned])).toEqual([
      ['2026-08-24T20:41:34Z', 'dev-4', '\u{1F195} New', null, null],
      ['2026-08-24T21:47:40Z', 'dev-14', null, 'dev-14', null],
      ['2026-08-24T21:47:42Z', 'dev-14', '\u{1F381} Assigned', null, null],
      ['2026-09-02T22:32:32Z', 'dev-14', '⚒️ Dev', null, null],
      ['2026-09-04T13:53:36Z', 'dev-14', '\u{1F50D} Dev Review', null, null],
      ['2026-09-04T13:53:44Z', 'dev-14', null, null, 'dev-14'],
      ['2026-09-04T16:28:42Z', 'dev-13', null, 'dev-1', null],
    ]);
  });

  it('carries where a move came from, since the last act on a card is often a bare assignment', async () => {
    const events = (await contextOf('context-handover', { number: 19192, pullRequest: null })).stateEvents;

    expect(events.find((e) => e.at === '2026-09-04T13:53:36Z')?.status).toEqual({
      from: '⚒️ Dev',
      to: '\u{1F50D} Dev Review',
    });
    // Project additions have an empty previous status.
    expect(events[0]?.status).toEqual({ from: '', to: '\u{1F195} New' });
  });

  it('ignores status changes from other projects', async () => {
    // Ignore status changes from other projects.
    const elsewhere = await contextOf('context-handover', { number: 19192, pullRequest: null }, config({ projectNumber: 99 }));

    expect(elsewhere.stateEvents.filter((e) => e.status !== null)).toEqual([]);
    expect(elsewhere.stateEvents.filter((e) => e.status === null)).toHaveLength(3);
  });

  it('ignores status changes on the same project number under another owner', async () => {
    // The recording predates the owner lookup; derive it, as the fixtures README allows.
    const owned = structuredClone(fixture('context-handover')) as {
      data: { repository: { issue: { timelineItems: { nodes: { __typename: string; project?: Record<string, unknown> | null }[] } } } };
    };

    for (const node of owned.data.repository.issue.timelineItems.nodes) {
      if (node.__typename === 'ProjectV2ItemStatusChangedEvent' && node.project) {
        node.project['owner'] = { login: 'example-org' };
      }
    }

    const ours = await fetchCardContext(config(), card({ number: 19192, pullRequest: null }), runnerOf(owned), new AbortController().signal);
    const theirs = await fetchCardContext(config({ projectOwner: 'someone-else' }), card({ number: 19192, pullRequest: null }), runnerOf(owned), new AbortController().signal);

    expect(ours.context?.stateEvents.filter((e) => e.status !== null)).toHaveLength(4);
    expect(theirs.context?.stateEvents.filter((e) => e.status !== null)).toEqual([]);
    expect(theirs.context?.stateEvents.filter((e) => e.status === null)).toHaveLength(3);
  });

  /** GitHub records timeline status events for the built-in Status field only (M32); another field's moves are not on the timeline. */
  it('keeps assignments but no status moves when another field supplies the status', async () => {
    const events = (await contextOf('context-handover', { number: 19192, pullRequest: null }, config({ statusField: 'Stage' }))).stateEvents;

    expect(events.filter((e) => e.status !== null)).toEqual([]);
    expect(events.filter((e) => e.assigned !== null || e.unassigned !== null)).toHaveLength(3);
  });

  it('drops a status cleared rather than reading it as a move to nowhere', async () => {
    // Derive null status for a cleared field; the API cannot produce it on demand. Ignore empty destinations because empty from already means project addition.
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
    // Derive a legacy response without timeline fields; current queries always request them.
    const older = structuredClone(fixture('context-no-pr')) as {
      data: { repository: { issue: Record<string, unknown> } };
    };
    delete older.data.repository.issue['timelineItems'];

    const reading = await fetchCardContext(
      config(),
      card({ number: 19231, pullRequest: null }),
      runnerOf(older),
      new AbortController().signal,
    );

    expect(reading.context?.stateEvents).toEqual([]);
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

  it('reports the omitted character count', () => {
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
