import { describe, expect, it } from 'vitest';
import type { TriageContext } from '@ground-control/core';
import { TRIAGE_SYSTEM_PROMPT, buildTriagePrompt } from '../src/triagePrompt.js';
import { TRIAGE_ACTIONS } from '../src/triage.js';

/** The six the hub reads off the pull request itself. Offering them invites a guess at something already known. */
const DERIVED = ['fix-checks', 'merge-upstream', 'resolve-conflicts', 'land'];

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
      expect(TRIAGE_SYSTEM_PROMPT.includes(`- ${action}:`)).toBe(!DERIVED.includes(action));
    }
  });

  it('asks for the one sentence length the parser enforces', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('160 characters');
  });
});

describe('building the prompt', () => {
  it('carries the issue, its status and its conversation in order', () => {
    const prompt = buildTriagePrompt(context({ comments: [comment('dev-2', 'First.'), comment('dev-3', 'Second.')] }));

    expect(prompt).toContain('ISSUE #17198: Channel mapping drops rows past the first page');
    expect(prompt).toContain('Board status: ⚒️ Dev');
    expect(prompt).toContain('The second page comes back empty.');
    expect(prompt.indexOf('First.')).toBeLessThan(prompt.indexOf('Second.'));
  });

  it('marks which words are the developer own, which is what two of the actions turn on', () => {
    const prompt = buildTriagePrompt(context({ comments: [comment('dev-1', 'Mine.'), comment('dev-2', 'Theirs.')] }));

    expect(prompt).toContain('dev-1 (the developer), member');
    expect(prompt).toContain('dev-2, member');
    expect(prompt).not.toContain('dev-2 (the developer)');
  });

  it('matches an own login whatever its case, the way the lane rules do', () => {
    expect(buildTriagePrompt(context({ comments: [comment('DEV-1', 'Mine.')], logins: ['dev-1'] }))).toContain(
      'DEV-1 (the developer)',
    );
  });

  it('carries an author association, so a tester reads differently from a colleague', () => {
    expect(buildTriagePrompt(context())).toContain('dev-2, contributor');
  });

  it('says plainly when there is no pull request, rather than leaving a gap to infer from', () => {
    const prompt = buildTriagePrompt(context());

    expect(prompt).toContain('No pull request is linked to this issue.');
    expect(prompt).not.toContain('PULL REQUEST');
  });

  it('carries the pull request facts and whose it is', () => {
    const prompt = buildTriagePrompt(context({ pullRequest: pullRequest() }));

    expect(prompt).toContain('PULL REQUEST #4021: Fix paging');
    expect(prompt).toContain('Opened by: dev-1 (the developer)');
    expect(prompt).toContain('State: OPEN');
    expect(prompt).toContain('Review decision: CHANGES_REQUESTED');
    expect(prompt).toContain('Reviewers asked for: dev-5');
    expect(prompt).toContain('Reviews submitted: dev-4 CHANGES_REQUESTED');
  });

  it('marks a draft, because a draft asks for nothing yet', () => {
    expect(buildTriagePrompt(context({ pullRequest: pullRequest({ isDraft: true }) }))).toContain('State: OPEN (draft)');
  });

  it('carries only the threads still open, and counts them', () => {
    const prompt = buildTriagePrompt(context({ pullRequest: pullRequest() }));

    expect(prompt).toContain('Unresolved review threads (1):');
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
    );

    expect(bare).toContain("The developer's own GitHub accounts: (none)");
    expect(bare).toContain('Recent issue comments (oldest first):\n(none)');
    expect(bare).toContain('Review decision: (none)');
    expect(bare).toContain('Reviewers asked for: (none)');
    expect(bare).toContain('Reviews submitted: (none)');
    expect(bare).toContain('Unresolved review threads (0):\n(none)');
  });

  it('is a pure function of its context, so what reached the model can always be read back', () => {
    expect(buildTriagePrompt(context({ pullRequest: pullRequest() }))).toBe(
      buildTriagePrompt(context({ pullRequest: pullRequest() })),
    );
  });
});
