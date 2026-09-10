import { describe, expect, it } from 'vitest';
import { buildSearchQuery } from '../src/index.js';
import { ASSIGNED_ISSUES_QUERY, CARD_CONTEXT_QUERY, DETAIL_EVENTS_QUERY, DETAIL_QUERY, DETAIL_THREADS_QUERY, ISSUE_BY_NUMBER_QUERY } from '../src/queries.js';
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

  /** The parser defaults a missing issue author to null, which would silently disable the issue-author policy. */
  it('asks the issue itself for its author', () => {
    const outsidePullRequests = ASSIGNED_ISSUES_QUERY.replace(/closedByPullRequestsReferences[\s\S]*?\n  \}\}/, '');

    expect(outsidePullRequests).toMatch(/\n  author\{ login avatarUrl\(size:40\) \}/);
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

  it('takes the project owner from the repo when none is set', () => {
    expect(buildSearchQuery(config({ repo: 'someone/else', projectNumber: 9 }), true)).toContain('project:someone/9');
  });

  it('reads the status field through a variable, so the document never names one field', () => {
    for (const query of [ASSIGNED_ISSUES_QUERY, ISSUE_BY_NUMBER_QUERY]) {
      expect(query).toContain('$status:String!');
      expect(query).toContain('fieldValueByName(name:$status)');
      expect(query).toContain('field(name:$status){ __typename }');
      expect(query).not.toContain('"Status"');
    }
  });

  it('names the configured project owner, since a project need not belong to the repository owner', () => {
    expect(buildSearchQuery(config({ repo: 'someone/else', projectNumber: 9, projectOwner: 'their-org' }), true)).toContain('project:their-org/9');
  });
});

describe('the conversation documents', () => {
  const documents = { DETAIL_QUERY, DETAIL_EVENTS_QUERY, DETAIL_THREADS_QUERY };

  it.each(Object.entries(documents))('resolves every part of %s, leaving no unexpanded reference', (_name, document) => {
    // These are composed from shared strings; an unexpanded `${NAME}` reaches GitHub as a syntax error.
    expect(document).not.toContain('${');
  });

  it.each(Object.entries(documents))('spreads exactly the fragments %s defines', (_name, document) => {
    const defined = [...document.matchAll(/fragment (\w+) on/g)].map((match) => match[1]).sort();
    const spread = [...new Set([...document.matchAll(/\.\.\.(\w+)/g)].map((match) => match[1]))].sort();

    // GraphQL rejects a document that defines a fragment it never spreads, and one that spreads an undefined one.
    expect(spread).toEqual(defined);
  });

  it.each(Object.entries(documents))('reads %s with balanced braces', (_name, document) => {
    let depth = 0;

    for (const character of document) {
      depth += character === '{' ? 1 : character === '}' ? -1 : 0;
      expect(depth).toBeGreaterThanOrEqual(0);
    }

    expect(depth).toBe(0);
  });

  it('asks each timeline union only for the event types its own fragment can read', () => {
    const arms = (fragment: string) =>
      new Set([...(new RegExp(`fragment ${fragment} on \\w+\\{([\\s\\S]*?)\\n\\}`).exec(DETAIL_QUERY)?.[1] ?? '').matchAll(/\.\.\. on (\w+)\{/g)].map((match) => match[1]));
    const asked = (union: string) =>
      new Set(
        (new RegExp(`timelineItems\\(last:100, before:\\$events, itemTypes:\\[([^\\]]*)\\]`, 'g').exec(union)?.[1] ?? '')
          .split(',')
          .map((type) => type.trim().split('_').map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(''))
          .filter(Boolean),
      );

    const [issueList, prList] = DETAIL_QUERY.split('pullRequest(number:$number)');

    // Guard against comparing two empty sets, which would pass while asserting nothing.
    expect(arms('issueEvent').size).toBeGreaterThan(10);
    expect(asked(issueList ?? '').size).toBe(arms('issueEvent').size);

    // A requested type with no matching arm returns a bare __typename the mapper drops; the reverse is dead selection.
    expect([...asked(issueList ?? '')].sort()).toEqual([...arms('issueEvent')].sort());
    expect([...asked(prList ?? '')].sort()).toEqual([...arms('prEvent')].sort());
  });
});
