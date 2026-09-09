import { describe, expect, it } from 'vitest';
import { buildSearchQuery } from '../src/index.js';
import { ASSIGNED_ISSUES_QUERY, CARD_CONTEXT_QUERY } from '../src/queries.js';
import { config } from './helpers.js';

describe('ASSIGNED_ISSUES_QUERY', () => {
  /** Assert author, draft, and review fields within the PR selection; parser defaults could hide a misplaced query field. */
  it('asks the pull request for what a lane and a card evidence string are read from', () => {
    const selection = /closedByPullRequestsReferences\(first:5\)\{ nodes\{([\s\S]*?)\n  \}\}/.exec(ASSIGNED_ISSUES_QUERY)?.[1];

    expect(selection).toBeTruthy();

    for (const field of ['isDraft', 'reviewDecision', 'author', 'updatedAt', 'oid', 'statusCheckRollup']) {
      expect(selection).toContain(field);
    }
  });

  /** GraphQL cost depends on requested nodes: this commits selection costs 8 points at first:5 and 103 at first:100 (M48). Only one PR is displayed. */
  it('asks for five closing pull requests, not a hundred', () => {
    expect(ASSIGNED_ISSUES_QUERY).toContain('closedByPullRequestsReferences(first:5)');
    expect(ASSIGNED_ISSUES_QUERY).not.toContain('closedByPullRequestsReferences(first:100)');
  });
});

describe('CARD_CONTEXT_QUERY', () => {
  /** Do not fetch unused mergeability; merge requests come from instructions and action outcomes from session reports (R39). */
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
