import { describe, expect, it } from 'vitest';
import { ISSUE_BY_NUMBER_QUERY, fetchAssignedIssues, fetchIssue } from '../src/index.js';
import { config, fixture, runnerOf } from './helpers.js';

type Item = { project: Record<string, unknown>; fieldValueByName: unknown };
type Page = { data: { cards: { nodes: { projectItems: { nodes: Item[] } }[] } } };

/**
 * The recordings predate the owner and field lookups, which the API cannot omit on demand. Derive them here, as
 * the fixtures README allows, rather than editing recordings by hand.
 */
function withProject(name: string, project: { owner?: string | Record<string, never>; field?: { __typename: string } | null; value?: unknown }): Page {
  const page = structuredClone(fixture(name)) as Page;

  for (const node of page.data.cards.nodes) {
    for (const item of node.projectItems.nodes) {
      if (project.owner !== undefined) {
        item.project['owner'] = typeof project.owner === 'string' ? { login: project.owner } : project.owner;
      }

      if (project.field !== undefined) {
        item.project['field'] = project.field;
      }

      if ('value' in project) {
        item.fieldValueByName = project.value;
      }
    }
  }

  return page;
}

async function unwrap(...args: Parameters<typeof fetchAssignedIssues>) {
  const result = await fetchAssignedIssues(...args);

  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`);
  }

  return result.value;
}

describe('fetchAssignedIssues', () => {
  /** Bound every page request so stalled networking cannot block subsequent refreshes. */
  it('bounds every page it asks for', async () => {
    const runner = runnerOf(fixture('project-mode'));
    await unwrap(config(), runner);

    expect(runner.bounds).not.toEqual([]);

    for (const bound of runner.bounds) {
      expect(bound?.timeoutMs).toBeGreaterThan(0);
    }
  });

  it('maps a recorded response to cards', async () => {
    const value = await unwrap(config(), runnerOf(fixture('project-mode')));

    expect(value.cards).toHaveLength(15);
    expect(value.cards.find((c) => c.number === 18953)).toEqual({
      number: 18953,
      title: "Guest portal drops rows past the first page",
      repository: 'example-org/example-repo',
      type: 'Bug',
      typeColor: 'RED',
      url: 'https://github.com/example-org/example-repo/issues/18953',
      // Defaulted, not recorded: the assigned search is `is:open`, so an older recording carries no state.
      state: 'OPEN',
      status: '⚒️ Dev',
      statusColor: 'GRAY',
      // Null because this recording predates the selection, which is exactly what an older recording must read as.
      statusChangedAt: null,
      assignees: ['dev-1', 'dev-1-bot'],
      avatar: { login: 'dev-1', url: 'https://avatars.githubusercontent.com/dev-1?s=40', source: 'issue' },
      pullRequest: {
        number: 19296,
        url: "https://github.com/example-org/example-repo/pull/19296",
        state: "OPEN",
        author: 'dev-1-bot',
        isDraft: false,
        reviewDecision: null,
        updatedAt: '2026-09-01T14:19:03Z',
        headOid: null,
        checksRed: null,
      },
      updatedAt: "2026-08-31T20:51:27Z",
    });
  });

  it('carries when the status last moved, which is what makes a card due to be read again', async () => {
    // Derive ProjectV2ItemFieldSingleSelectValue.updatedAt because existing search fixtures predate its selection.
    const stamped = structuredClone(fixture('project-mode')) as {
      data: { cards: { nodes: { number: number; projectItems: { nodes: { fieldValueByName: { updatedAt?: string } | null }[] } }[] } };
    };
    const node = stamped.data.cards.nodes.find((n) => n.number === 18953)!;

    for (const item of node.projectItems.nodes) {
      if (item.fieldValueByName) {
        item.fieldValueByName.updatedAt = '2026-09-04T13:53:36Z';
      }
    }

    const value = await unwrap(config(), runnerOf(stamped));

    expect(value.cards.find((c) => c.number === 18953)?.statusChangedAt).toBe('2026-09-04T13:53:36Z');
    // Keep other fixture timestamps null to verify per-card mapping.
    expect(value.cards.filter((c) => c.statusChangedAt !== null)).toHaveLength(1);
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
      updatedAt: '2026-09-02T00:52:30Z',
      // Null for the same reason `statusChangedAt` is: the recording predates the commit selection.
      headOid: null,
      checksRed: null,
    });
  });

  /** Author, draft state, and review decision determine arrival lanes. */
  it('reads PR author, draft state, and review decision', async () => {
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

  it('preserves GitHub type and status colors', async () => {
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

    // Use two recorded PRs with different authors so recency determines the selected avatar.
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

  it('tells the same project number under another owner apart from the configured project', async () => {
    const owned = withProject('project-mode', { owner: 'example-org' });
    const ours = await unwrap(config(), runnerOf(owned));
    const theirs = await unwrap(config({ projectOwner: 'someone-else' }), runnerOf(owned));

    expect(ours.cards.find((c) => c.number === 18953)?.status).toBe('⚒️ Dev');
    expect(theirs.cards.every((c) => c.status === null)).toBe(true);
    expect(theirs.sourceQuery).toContain('project:someone-else/3');
  });

  it('does not take an owner of a kind without a login for the configured one', async () => {
    const value = await unwrap(config(), runnerOf(withProject('project-mode', { owner: {} })));

    expect(value.cards.every((c) => c.status === null)).toBe(true);
  });

  it('compares project owners as GitHub compares logins, ignoring case', async () => {
    const value = await unwrap(config({ projectOwner: 'EXAMPLE-org' }), runnerOf(withProject('project-mode', { owner: 'Example-Org' })));

    expect(value.cards.find((c) => c.number === 18953)?.status).toBe('⚒️ Dev');
  });

  it('asks for the configured field by name, on both reads', async () => {
    const pages = runnerOf(fixture('project-mode'));
    await unwrap(config({ statusField: 'Stage' }), pages);

    expect(pages.calls[0]).toContain('status=Stage');

    const one = runnerOf(fixture('issue-by-number'));
    await fetchIssue(config({ statusField: 'Stage' }), 'example-org', 'example-repo', 1, one);

    expect(one.calls[0]).toContain('status=Stage');
  });

  it('carries a custom field value, its color, and when it changed, the same as the built-in one', async () => {
    const custom = withProject('project-mode', {
      owner: 'example-org',
      field: { __typename: 'ProjectV2SingleSelectField' },
      value: { name: 'Building', color: 'BLUE', updatedAt: '2026-09-08T10:00:00Z' },
    });
    const value = await unwrap(config({ statusField: 'Stage' }), runnerOf(custom));

    expect(value.fieldProblem).toBeNull();
    expect(value.cards[0]).toMatchObject({ status: 'Building', statusColor: 'BLUE', statusChangedAt: '2026-09-08T10:00:00Z' });
  });

  it('reports a project that has no such field, and keeps the cards on the board', async () => {
    const value = await unwrap(config({ statusField: 'Stage' }), runnerOf(withProject('project-mode', { owner: 'example-org', field: null, value: null })));

    expect(value.fieldProblem).toBe('Project example-org/3 has no field named "Stage".');
    expect(value.cards).toHaveLength(15);
    expect(value.cards.every((c) => c.status === null)).toBe(true);
  });

  it('reports a field of another type by what it is, whose value matches no fragment and arrives empty', async () => {
    const value = await unwrap(config({ statusField: 'Notes' }), runnerOf(withProject('project-mode', { owner: 'example-org', field: { __typename: 'ProjectV2Field' }, value: {} })));

    expect(value.fieldProblem).toBe('The "Notes" field on project example-org/3 is a ProjectV2Field, not a single-select field.');
    expect(value.cards.every((c) => c.status === null)).toBe(true);
  });

  it('treats an unset value on a single-select field as no status, not as a problem', async () => {
    const value = await unwrap(config(), runnerOf(withProject('project-mode', { owner: 'example-org', field: { __typename: 'ProjectV2SingleSelectField' }, value: null })));

    expect(value.fieldProblem).toBeNull();
    expect(value.cards.every((c) => c.status === null && c.statusChangedAt === null)).toBe(true);
  });

  it('says nothing about a field on a project none of the cards are on', async () => {
    const value = await unwrap(config({ projectOwner: 'someone-else' }), runnerOf(withProject('project-mode', { owner: 'example-org', field: null })));

    expect(value.fieldProblem).toBeNull();
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
      runner.calls[0]?.some((a) => a.startsWith('query=') && a.includes('closedByPullRequestsReferences(first:5)')),
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

  it('returns issueSearch results without project exclusions', async () => {
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

  it('reports zero exclusions when the filter matches all issues', async () => {
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

  it('reports no truncation when the final page has no successor', async () => {
    const value = await unwrap(config(), runnerOf(fixture('project-mode')));

    expect(value.truncated).toBe(false);
  });

  it('collapses an issue that appears on two pages into one card', async () => {
    const page = fixture('paged-page1');
    const value = await unwrap(config({ maxPages: 2 }), runnerOf(page, page));

    expect(value.cards).toHaveLength(3);
  });

  it('limits pagination to maxPages', async () => {
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

describe('fetchIssue', () => {
  it('maps a recorded issue read by number, whatever its state and whoever holds it', async () => {
    const result = await fetchIssue(config(), 'example-org', 'example-repo', 15619, runnerOf(fixture('issue-by-number')));

    expect(result.ok && result.value).toEqual({
      number: 15619,
      title: 'Inbox badge fails silently on an empty result',
      repository: 'example-org/example-repo',
      state: 'CLOSED',
      type: 'Feature',
      typeColor: 'BLUE',
      url: 'https://github.com/example-org/example-repo/issues/15619',
      status: '🚀 Releasable',
      statusColor: 'GRAY',
      statusChangedAt: '2026-07-30T18:37:03Z',
      assignees: [],
      avatar: null,
      pullRequest: {
        number: 16253,
        url: 'https://github.com/example-org/example-repo/pull/16253',
        state: 'MERGED',
        author: 'dev-1',
        isDraft: false,
        reviewDecision: 'REVIEW_REQUIRED',
        updatedAt: '2026-08-04T21:19:52Z',
        headOid: null,
        checksRed: null,
      },
      updatedAt: '2026-08-04T19:40:41Z',
    });
  });

  it('asks the repository and the number it was given, and bounds the read', async () => {
    const runner = runnerOf(fixture('issue-by-number'));
    await fetchIssue(config(), 'example-org', 'example-repo', 15619, runner);

    expect(runner.calls[0]).toEqual([
      'api',
      'graphql',
      '-f',
      `query=${ISSUE_BY_NUMBER_QUERY}`,
      '-f',
      'owner=example-org',
      '-f',
      'name=example-repo',
      '-F',
      'number=15619',
      '-f',
      'status=Status',
    ]);
    expect(runner.bounds[0]?.timeoutMs).toBeGreaterThan(0);
  });

  // Missing branch-derived issues leave sessions unlinked without an error.
  it('answers with no card where GitHub reports no such issue', async () => {
    const result = await fetchIssue(config(), 'example-org', 'example-repo', 99999, runnerOf({ data: { repository: { issue: null } } }));

    expect(result).toEqual({ ok: true, value: null });
  });

  it('answers with no card where GitHub reports no such repository', async () => {
    const result = await fetchIssue(config(), 'example-org', 'gone', 1, runnerOf({ data: { repository: null } }));

    expect(result).toEqual({ ok: true, value: null });
  });

  it('refuses a response whose shape it does not recognise', async () => {
    const result = await fetchIssue(config(), 'example-org', 'example-repo', 1, runnerOf({ data: {} }));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('bad-response');
  });

  it('passes a runner failure straight through rather than reading it as a missing issue', async () => {
    const failing = (async () => ({ ok: false, error: { kind: 'offline', message: 'no network', remedy: 'try later' } })) as never;
    const result = await fetchIssue(config(), 'example-org', 'example-repo', 1, failing);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('offline');
  });
});
