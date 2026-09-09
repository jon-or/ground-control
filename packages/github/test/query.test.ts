import { describe, expect, it } from 'vitest';
import { buildSearchQuery } from '../src/index.js';
import { ASSIGNED_ISSUES_QUERY, CARD_CONTEXT_QUERY } from '../src/queries.js';
import { config } from './helpers.js';

describe('ASSIGNED_ISSUES_QUERY', () => {
  /**
   * On the pull request itself, not merely somewhere in the document: the parser defaults all three, so a query that asked for them in the
   * wrong place would still parse and map every card as a non-draft nobody opened — and a card holds no lane at all without the author.
   */
  it('asks the pull request for what a lane and a card evidence string are read from', () => {
    const selection = /closedByPullRequestsReferences\(first:5\)\{ nodes\{([\s\S]*?)\n  \}\}/.exec(ASSIGNED_ISSUES_QUERY)?.[1];

    expect(selection).toBeTruthy();

    for (const field of ['isDraft', 'reviewDecision', 'author', 'updatedAt', 'oid', 'statusCheckRollup']) {
      expect(selection).toContain(field);
    }
  });

  /**
   * GraphQL bills the nodes asked for, not the nodes returned, so the `commits` selection above costs 8 points at
   * `first:5` and 103 at `first:100` (`docs/mechanics.md` M48). `selectPullRequest` returns one.
   */
  it('asks for five closing pull requests, not a hundred', () => {
    expect(ASSIGNED_ISSUES_QUERY).toContain('closedByPullRequestsReferences(first:5)');
    expect(ASSIGNED_ISSUES_QUERY).not.toContain('closedByPullRequestsReferences(first:100)');
  });
});

describe('CARD_CONTEXT_QUERY', () => {
  /**
   * R39: a merge is something somebody asks for, and a run's success is the run's own signal. Nothing on this board
   * reads GitHub's mergeability, so asking for it would be a field fetched on every card read with no consumer.
   */
  it('asks for no mergeability', () => {
    expect(CARD_CONTEXT_QUERY).not.toContain('mergeable');
    expect(CARD_CONTEXT_QUERY).not.toContain('mergeStateStatus');
  });

  it('asks for the head commit a run is authorised against', () => {
    expect(CARD_CONTEXT_QUERY).toContain('commit{ oid');
  });
});

describe('buildSearchQuery', () => {
  it('adds one assignee qualifier per login', () => {
    expect(buildSearchQuery(config({ logins: ['dev-1', 'dev-1-bot'] }), false)).toBe(
      'repo:example-org/example-repo is:issue is:open assignee:dev-1 assignee:dev-1-bot',
    );
  });

  it('adds the project qualifier only when asked', () => {
    expect(buildSearchQuery(config(), true)).toContain('project:example-org/3');
    expect(buildSearchQuery(config(), false)).not.toContain('project:');
  });

  it('takes the project owner from the repo, not a separate setting', () => {
    expect(buildSearchQuery(config({ repo: 'someone/else', projectNumber: 9 }), true)).toContain('project:someone/9');
  });
});
