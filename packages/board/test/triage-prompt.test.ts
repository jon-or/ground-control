import { describe, expect, it } from 'vitest';
import type { TriageContext } from '@ground-control/core';
import { TRIAGE_SYSTEM_PROMPT, buildTriagePrompt } from '../src/triagePrompt.js';
import { TRIAGE_ACTIONS } from '../src/triage.js';

/** The four the hub reads off the pull request itself, offered to the model neither here nor in the schema. */
const DERIVED = ['fix-checks', 'merge-upstream', 'resolve-conflicts', 'land'];

const NOW = Date.parse('2026-09-05T12:00:00Z');

function comment(author: string, body: string, association = 'MEMBER') {
  return { author, authorAssociation: association, body, createdAt: '2026-09-01T09:00:00Z' };
}

function context(over: Partial<TriageContext> = {}): TriageContext {
  return {
    issueNumber: 17198,
    title: 'Channel mapping drops rows past the first page',
    body: 'The second page comes back empty.',
    status: '⚒️ Dev',
    comments: [comment('dev-2', 'Still broken on Safari.', 'CONTRIBUTOR')],
    logins: ['dev-1'],
    pullRequest: null,
    ...over,
  };
}

function pullRequest(over = {}) {
  return {
    number: 4021,
    title: 'Fix paging',
    body: 'Fixes the offset.',
    state: 'OPEN',
    isDraft: false,
    author: 'dev-1',
    reviewDecision: 'CHANGES_REQUESTED',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    checkState: 'SUCCESS',
    comments: [comment('dev-4', 'A couple of naming notes.')],
    reviews: [{ author: 'dev-4', state: 'CHANGES_REQUESTED', submittedAt: '2026-09-01T09:30:00Z' }],
    reviewRequests: ['dev-5'],
    threads: [
      { isResolved: false, isOutdated: false, comments: [comment('dev-4', 'This name is wrong.')] },
      { isResolved: true, isOutdated: false, comments: [comment('dev-4', 'Settled already.')] },
      { isResolved: false, isOutdated: true, comments: [comment('dev-4', 'Moved on since.')] },
    ],
    ...over,
  };
}

describe('the system prompt', () => {
  it('names every action the model decides, and none the hub reads for itself', () => {
    for (const action of TRIAGE_ACTIONS) {
      expect(TRIAGE_SYSTEM_PROMPT.includes(`${action}:`)).toBe(!DERIVED.includes(action));
    }
  });

  it('gives an order to take when more than one fits, since several routinely do', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('take the first that applies');
    // The order the numbers put them in, which is the whole of what the rule is worth.
    const order = ['uat-failure', 'uat-question', 'answer-design-question', 'address-review', 'review-others', 'awaiting-others', 'begin-work', 'other'];
    const at = order.map((action) => TRIAGE_SYSTEM_PROMPT.indexOf(`${action}:`));

    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(at.every((i) => i > 0)).toBe(true);
  });

  it('says an assigned issue with nothing on it is begin-work, since that is most of a first run', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('is begin-work, not other');
  });

  it('tells the model what day it is, since three of the actions turn on recency', () => {
    expect(buildTriagePrompt(context(), Date.parse('2026-09-05T12:00:00Z'))).toContain('Today is 2026-09-05.');
  });

  it('asks for the one sentence length the parser enforces', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('160 characters');
  });
});

describe('building the prompt', () => {
  it('carries the issue, its status and its conversation in order', () => {
    const prompt = buildTriagePrompt(context({ comments: [comment('dev-2', 'First.'), comment('dev-3', 'Second.')] }), NOW);

    expect(prompt).toContain('ISSUE #17198: Channel mapping drops rows past the first page');
    expect(prompt).toContain('Board status: ⚒️ Dev');
    expect(prompt).toContain('The second page comes back empty.');
    expect(prompt.indexOf('First.')).toBeLessThan(prompt.indexOf('Second.'));
  });

  it('marks which words are the developer own, which is what two of the actions turn on', () => {
    const prompt = buildTriagePrompt(context({ comments: [comment('dev-1', 'Mine.'), comment('dev-2', 'Theirs.')] }), NOW);

    expect(prompt).toContain('dev-1 (the developer), member');
    expect(prompt).toContain('dev-2, member');
    expect(prompt).not.toContain('dev-2 (the developer)');
  });

  it('matches an own login whatever its case, the way the lane rules do', () => {
    expect(buildTriagePrompt(context({ comments: [comment('DEV-1', 'Mine.')], logins: ['dev-1'] }), NOW)).toContain(
      'DEV-1 (the developer)',
    );
  });

  it('carries an author association, so a tester reads differently from a colleague', () => {
    expect(buildTriagePrompt(context(), NOW)).toContain('dev-2, contributor');
  });

  it('spells out what no association means, rather than rendering GitHub NONE as if it were an error', () => {
    const outsider = buildTriagePrompt(context({ comments: [comment('dev-9', 'Broken for me.', 'NONE')] }), NOW);

    expect(outsider).toContain('dev-9, not a member of the repository');
    expect(outsider).not.toContain('dev-9, none');
  });

  it('says plainly when there is no pull request, rather than leaving a gap to infer from', () => {
    const prompt = buildTriagePrompt(context(), NOW);

    expect(prompt).toContain('No pull request is linked to this issue.');
    expect(prompt).not.toContain('PULL REQUEST');
  });

  it('carries the pull request facts and whose it is', () => {
    const prompt = buildTriagePrompt(context({ pullRequest: pullRequest() }), NOW);

    expect(prompt).toContain('PULL REQUEST #4021: Fix paging');
    expect(prompt).toContain('Opened by: dev-1 (the developer)');
    expect(prompt).toContain('State: OPEN');
    expect(prompt).toContain('Review decision: CHANGES_REQUESTED');
    expect(prompt).toContain('Reviewers asked for: dev-5');
    expect(prompt).toContain('Reviews submitted: dev-4 CHANGES_REQUESTED');
  });

  it('marks a draft, because a draft asks for nothing yet', () => {
    expect(buildTriagePrompt(context({ pullRequest: pullRequest({ isDraft: true }) }), NOW)).toContain('State: OPEN (draft)');
  });

  it('carries only the threads still open, and counts them', () => {
    const prompt = buildTriagePrompt(context({ pullRequest: pullRequest() }), NOW);

    expect(prompt).toContain('Unresolved review threads (1):');
    expect(prompt).toContain('Thread 1:');
    expect(prompt).toContain('This name is wrong.');
    expect(prompt).not.toContain('Settled already.');
    expect(prompt).not.toContain('Moved on since.');
  });

  it('writes (none) rather than a blank wherever there is nothing, so an absence is never a gap', () => {
    const bare = buildTriagePrompt(
      context({
        body: '',
        comments: [],
        logins: [],
        pullRequest: pullRequest({ comments: [], reviews: [], reviewRequests: [], threads: [], reviewDecision: null }),
      }),
      NOW,
    );

    expect(bare).toContain("The developer's own GitHub accounts: (none)");
    expect(bare).toContain('Recent issue comments (oldest first):\n(none)');
    expect(bare).toContain('Review decision: (none)');
    expect(bare).toContain('Reviewers asked for: (none)');
    expect(bare).toContain('Reviews submitted: (none)');
    expect(bare).toContain('Unresolved review threads (0):\n(none)');
  });

  it('numbers each open thread, so three threads never read as one thread with three comments', () => {
    const many = pullRequest({
      threads: [
        { isResolved: false, isOutdated: false, comments: [comment('dev-4', 'First point.')] },
        { isResolved: false, isOutdated: false, comments: [comment('dev-5', 'Second point.')] },
      ],
    });
    const prompt = buildTriagePrompt(context({ pullRequest: many }), NOW);

    expect(prompt).toContain('Unresolved review threads (2):');
    expect(prompt).toContain('Thread 1:');
    expect(prompt).toContain('Thread 2:');
    expect(prompt.indexOf('Thread 1:')).toBeLessThan(prompt.indexOf('Thread 2:'));
  });

  it('is a pure function of its context, so what reached the model can always be read back', () => {
    expect(buildTriagePrompt(context({ pullRequest: pullRequest() }), NOW)).toBe(
      buildTriagePrompt(context({ pullRequest: pullRequest() }), NOW),
    );
  });
});
