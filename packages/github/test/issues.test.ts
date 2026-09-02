import { describe, expect, it } from 'vitest';
import { fetchAssignedIssues } from '../src/index.js';
import { config, fixture, runnerOf } from './helpers.js';

async function unwrap(...args: Parameters<typeof fetchAssignedIssues>) {
  const result = await fetchAssignedIssues(...args);

  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`);
  }

  return result.value;
}

describe('fetchAssignedIssues', () => {
  it('maps a recorded response to cards', async () => {
    const value = await unwrap(config(), runnerOf(fixture('project-mode')));

    expect(value.cards).toHaveLength(15);
    expect(value.cards.find((c) => c.number === 18953)).toEqual({
      number: 18953,
      title: "Guest portal drops rows past the first page",
      type: 'Bug',
      typeColor: 'RED',
      url: 'https://github.com/example-org/example-repo/issues/18953',
      status: '⚒️ Dev',
      statusColor: 'GRAY',
      assignees: ['dev-1', 'dev-1-bot'],
      avatar: { login: 'dev-1', url: 'https://avatars.githubusercontent.com/dev-1?s=40', source: 'issue' },
      pullRequest: {
        number: 19296,
        url: "https://github.com/example-org/example-repo/pull/19296",
        state: "OPEN",
        author: 'dev-1-bot',
        isDraft: false,
        reviewDecision: null,
      },
      updatedAt: "2026-08-31T20:51:27Z",
    });
  });

  it('uses the linked pull request author for a review card', async () => {
    const value = await unwrap(config({ logins: ['dev-2'] }), runnerOf(fixture('avatars')));
    const review = value.cards.find((card) => card.number === 19400);

    expect(review?.assignees).toEqual(['dev-2']);
    expect(review?.avatar).toEqual({
      login: 'dev-3',
      url: 'https://avatars.githubusercontent.com/dev-3?s=40',
      source: 'pull-request',
    });
  });

  it('names the pull request that would close the issue', async () => {
    const value = await unwrap(config({ logins: ['dev-2'] }), runnerOf(fixture('avatars')));

    expect(value.cards.find((card) => card.number === 19400)?.pullRequest).toEqual({
      number: 19403,
      url: 'https://github.com/example-org/example-repo/pull/19403',
      state: 'OPEN',
      author: 'dev-3',
      isDraft: false,
      reviewDecision: null,
    });
  });

  /** The board reads all three to decide which lane a card arrives in, and a card holds no lane at all without the author. */
  it('names who opened the pull request, whether it is a draft, and what its review said', async () => {
    const response = structuredClone(fixture('avatars')) as {
      data: { cards: { nodes: Array<{ number: number; pullRequests: { nodes: Array<Record<string, unknown>> } }> } };
    };
    const node = response.data.cards.nodes.find((n) => n.number === 19400)!.pullRequests.nodes[0]!;

    node.isDraft = true;
    node.reviewDecision = 'CHANGES_REQUESTED';
    node.author = null;

    const value = await unwrap(config({ logins: ['dev-2'] }), runnerOf(response));

    expect(value.cards.find((card) => card.number === 19400)?.pullRequest).toMatchObject({
      author: null,
      isDraft: true,
      reviewDecision: 'CHANGES_REQUESTED',
    });
  });

  it('speaks for an open pull request over a merged one somebody commented on later', async () => {
    const response = structuredClone(fixture('avatars')) as {
      data: { cards: { nodes: Array<{ number: number; pullRequests: { nodes: Array<Record<string, unknown>> } }> } };
    };
    const linked = response.data.cards.nodes.find((n) => n.number === 19400)!.pullRequests;
    const merged = linked.nodes[0]!;

    linked.nodes.push({ ...merged, number: 19500, state: 'OPEN', updatedAt: '2026-08-01T00:00:00Z' });
    merged.state = 'MERGED';
    merged.updatedAt = '2026-09-01T00:00:00Z';

    const value = await unwrap(config({ logins: ['dev-2'] }), runnerOf(response));

    expect(value.cards.find((card) => card.number === 19400)?.pullRequest?.number).toBe(19500);
  });

  it('carries GitHub own colour for the type and the status', async () => {
    const value = await unwrap(config({ logins: ['dev-2'] }), runnerOf(fixture('avatars')));
    const review = value.cards.find((card) => card.number === 19400);

    expect([review?.type, review?.typeColor]).toEqual(['Feature', 'BLUE']);
    expect([review?.status, review?.statusColor]).toEqual(['🔍 Dev Review', 'GRAY']);
  });

  it('keeps the most recently updated author when an older pull request is also linked', async () => {
    const response = structuredClone(fixture('avatars')) as {
      data: {
        cards: {
          nodes: Array<{
            assignees: { nodes: Array<{ login: string; avatarUrl: string }> };
            pullRequests: {
              nodes: Array<{
                number: number;
                url: string;
                state: string;
                updatedAt: string;
                author: { login: string; avatarUrl: string } | null;
              }>;
            };
          }>;
        };
      };
    };
    const [older, review] = response.data.cards.nodes;

    expect(older).toBeDefined();
    expect(review).toBeDefined();

    // Both pull requests are recorded; the older one is given the assignee as its author, so only the sort can decide.
    review!.pullRequests.nodes.push({ ...older!.pullRequests.nodes[0]!, author: review!.assignees.nodes[0]! });

    expect(older!.pullRequests.nodes[0]!.updatedAt < review!.pullRequests.nodes[0]!.updatedAt).toBe(true);

    const value = await unwrap(config({ logins: ['dev-2'] }), runnerOf(response));

    expect(value.cards.find((card) => card.number === 19400)?.avatar).toEqual({
      login: 'dev-3',
      url: 'https://avatars.githubusercontent.com/dev-3?s=40',
      source: 'pull-request',
    });
  });

  it('keeps the configured issue assignee while a linked pull request is still in Dev', async () => {
    const response = structuredClone(fixture('avatars')) as {
      data: {
        cards: {
          nodes: Array<{
            projectItems: { nodes: Array<{ fieldValueByName: { name: string; color: string | null } | null }> };
          }>;
        };
      };
    };
    const [dev, review] = response.data.cards.nodes;

    expect(dev).toBeDefined();
    expect(review).toBeDefined();

    // Both values are recorded: apply the recording's Dev status to its review case to isolate avatar precedence.
    review!.projectItems.nodes[0]!.fieldValueByName = structuredClone(dev!.projectItems.nodes[0]!.fieldValueByName);
    const value = await unwrap(config({ logins: ['dev-2'] }), runnerOf(response));

    expect(value.cards.find((card) => card.number === 19400)?.avatar).toEqual({
      login: 'dev-2',
      url: 'https://avatars.githubusercontent.com/dev-2?s=40',
      source: 'issue',
    });
  });

  it('uses the configured issue assignee when no pull request exists', async () => {
    // Derived from the recording by removing whole connection nodes: the same issue before its PR was linked.
    const response = structuredClone(fixture('avatars')) as {
      data: { cards: { nodes: Array<{ pullRequests: { nodes: unknown[] } }> } };
    };
    response.data.cards.nodes[0]!.pullRequests.nodes = [];
    const value = await unwrap(config({ logins: ['dev-1'] }), runnerOf(response));

    expect(value.cards[0]?.avatar).toEqual({
      login: 'dev-1',
      url: 'https://avatars.githubusercontent.com/dev-1?s=40',
      source: 'issue',
    });
    expect(value.cards[0]?.pullRequest).toBeNull();
  });

  it('uses config order rather than GitHub order when several of my accounts are assigned', async () => {
    const response = structuredClone(fixture('avatars')) as {
      data: {
        cards: {
          nodes: Array<{
            assignees: { nodes: Array<{ login: string; avatarUrl: string }> };
            pullRequests: { nodes: unknown[] };
          }>;
        };
      };
    };
    const [issue, other] = response.data.cards.nodes;

    expect(issue).toBeDefined();
    expect(other).toBeDefined();

    // Both actors are from the recording; put GitHub's order opposite the configured account preference.
    issue!.pullRequests.nodes = [];
    issue!.assignees.nodes = [issue!.assignees.nodes[0]!, other!.assignees.nodes[0]!];
    const value = await unwrap(config({ logins: ['dev-1', 'dev-2'] }), runnerOf(response));

    expect(value.cards[0]?.avatar).toEqual({
      login: 'dev-1',
      url: 'https://avatars.githubusercontent.com/dev-1?s=40',
      source: 'issue',
    });
  });

  it('reads status from the configured project, not whichever project came back first', async () => {
    const value = await unwrap(config({ projectNumber: 6 }), runnerOf(fixture('project-mode')));

    expect(value.cards.every((c) => c.status === null)).toBe(true);
  });

  it('leaves type null for an issue with no issue type', async () => {
    const value = await unwrap(config({ maxPages: 1 }), runnerOf(fixture('untyped')));

    expect(value.cards.map((c) => c.type)).toEqual([null, null]);
  });

  it('counts assigned issues the project filter excluded', async () => {
    const value = await unwrap(config(), runnerOf(fixture('not-on-project')));

    expect(value.cards).toHaveLength(0);
    expect(value.matched).toBe(0);
    expect(value.totalAssigned).toBe(15);
    expect(value.notOnProject).toBe(15);
    expect(value.truncated).toBe(false);
  });

  it('asks for the unfiltered count alongside the filtered one', async () => {
    const runner = runnerOf(fixture('not-on-project'));
    await unwrap(config(), runner);

    expect(runner.calls[0]).toContain('cards=repo:example-org/example-repo is:issue is:open assignee:dev-1 project:example-org/3');
    expect(runner.calls[0]).toContain('all=repo:example-org/example-repo is:issue is:open assignee:dev-1');
  });

  it('sends the query document, not only its variables', async () => {
    const runner = runnerOf(fixture('project-mode'));
    await unwrap(config(), runner);

    expect(runner.calls[0]?.[0]).toBe('api');
    expect(
      runner.calls[0]?.some((a) => a.startsWith('query=') && a.includes('closedByPullRequestsReferences(first:100)')),
    ).toBe(true);
  });

  it('reports what the board matched, not the wider assigned set, when a page budget cuts the list', async () => {
    const value = await unwrap(config({ maxPages: 1 }), runnerOf(fixture('project-truncated')));

    expect(value.cards).toHaveLength(3);
    expect(value.matched).toBe(1223);
    expect(value.totalAssigned).toBe(1753);
    expect(value.notOnProject).toBe(530);
    expect(value.truncated).toBe(true);
  });

  it('finds every card in issueSearch mode and reports nothing excluded', async () => {
    const runner = runnerOf(fixture('project-mode'));
    const value = await unwrap(config({ cardSource: 'issueSearch' }), runner);

    expect(value.cards).toHaveLength(15);
    expect(value.notOnProject).toBe(0);
    expect(runner.calls[0]?.some((a) => a.startsWith('cards=') && a.includes('project:'))).toBe(false);
  });

  it('stops walking when the cursor is null even though more pages are claimed', async () => {
    // Derived, not recorded: endCursor is nullable in the schema and the live API will not serve that on demand.
    const page = structuredClone(fixture('paged-page1')) as { data: { cards: { pageInfo: { endCursor: string | null } } } };
    page.data.cards.pageInfo.endCursor = null;

    const runner = runnerOf(page);
    const value = await unwrap(config({ maxPages: 5 }), runner);

    expect(runner.calls).toHaveLength(1);
    expect(value.cards).toHaveLength(3);
    expect(value.truncated).toBe(true);
  });

  it('reports nothing excluded when the filter matched everything', async () => {
    const value = await unwrap(config(), runnerOf(fixture('project-mode')));

    expect(value.notOnProject).toBe(0);
  });

  it('follows the cursor to the next page', async () => {
    const runner = runnerOf(fixture('paged-page1'), fixture('paged-page2'));
    const value = await unwrap(config({ maxPages: 2 }), runner);

    expect(value.cards.map((c) => c.number)).toEqual([19405, 19404, 19400, 19090, 19086]);
    expect(runner.calls[1]).toContain('after=Y3Vyc29yOjEwMA==');
  });

  it('reports truncation when matches remain after the last allowed page', async () => {
    const value = await unwrap(config({ maxPages: 2 }), runnerOf(fixture('paged-page1'), fixture('paged-page2')));

    expect(value.truncated).toBe(true);
    expect(value.cards).toHaveLength(5);
    expect(value.matched).toBe(1753);
  });

  it('does not report truncation when the last page said there was no next', async () => {
    const value = await unwrap(config(), runnerOf(fixture('project-mode')));

    expect(value.truncated).toBe(false);
  });

  it('collapses an issue that appears on two pages into one card', async () => {
    const page = fixture('paged-page1');
    const value = await unwrap(config({ maxPages: 2 }), runnerOf(page, page));

    expect(value.cards).toHaveLength(3);
  });

  it('stops at maxPages rather than paging forever', async () => {
    const page = fixture('paged-page1');
    const runner = runnerOf(page, page, page);
    await unwrap(config({ maxPages: 3 }), runner);

    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[2]).toContain('after=Y3Vyc29yOjEwMA==');
  });

  it('refuses to query with no logins, so the board never shows the whole repo as yours', async () => {
    const runner = runnerOf(fixture('project-mode'));
    const result = await fetchAssignedIssues(config({ logins: [] }), runner);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.kind).toBe('no-logins');
    expect(runner.calls).toHaveLength(0);
  });

  it('refuses a response whose shape it does not recognise', async () => {
    const result = await fetchAssignedIssues(config(), runnerOf({ data: { cards: {} } }));

    expect(result.ok === false && result.error.kind).toBe('bad-response');
  });

  it('passes a runner failure straight through', async () => {
    const failing = async () => ({ ok: false as const, error: { kind: 'gh-missing' as const, message: 'no gh', remedy: 'install it' } });
    const result = await fetchAssignedIssues(config(), failing);

    expect(result.ok === false && result.error.kind).toBe('gh-missing');
  });

  it('sends the query it reports sending', async () => {
    const runner = runnerOf(fixture('project-mode'));
    const value = await unwrap(config(), runner);

    expect(runner.calls[0]).toContain(`cards=${value.sourceQuery}`);
    expect(value.sourceQuery).toContain('project:example-org/3');
  });
});
