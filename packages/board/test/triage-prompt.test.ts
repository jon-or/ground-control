import { describe, expect, it } from 'vitest';
import type { TriageContext, TriageStateEvent } from '@ground-control/core';
import { TRIAGE_SYSTEM_PROMPT, buildTriagePrompt } from '../src/triagePrompt.js';
import { TRIAGE_ACTIONS } from '../src/triage.js';

const NOW = Date.parse('2026-09-05T12:00:00Z');

/** Shared heading for comments and state changes. */
const ACTIVITY = 'Recent activity — comments and state changes, oldest first:';

function comment(author: string, body: string, association = 'MEMBER', authorName: string | null = null) {
  return { author, authorName, authorAssociation: association, body, createdAt: '2026-09-01T09:00:00Z' };
}

function context(over: Partial<TriageContext> = {}): TriageContext {
  return {
    issueNumber: 17198,
    title: 'Channel mapping drops rows past the first page',
    body: 'The second page comes back empty.',
    status: '⚒️ Dev',
    stateEvents: [],
    comments: [comment('dev-2', 'Still broken on Safari.', 'CONTRIBUTOR')],
    logins: ['dev-1'],
    pullRequest: null,
    repository: 'example-org/example-repo',
    defaultBranch: 'master',
    ...over,
  };
}

function moved(at: string, actor: string, from: string, to: string): TriageStateEvent {
  return { at, actor, actorName: `${actor} Surname`, status: { from, to }, assigned: null, unassigned: null };
}

function assigned(at: string, actor: string, login: string): TriageStateEvent {
  return { at, actor, actorName: `${actor} Surname`, status: null, assigned: login, unassigned: null };
}

function pullRequest(over = {}) {
  return {
    number: 4021,
    title: 'Fix paging',
    body: 'Fixes the offset.',
    state: 'OPEN',
    isDraft: false,
    author: 'dev-1',
    authorName: null,
    baseRefName: 'master',
    headRefName: '17198-channel-mapping',
    headOid: '9ab0cde1111111111111111111111111111111ff',
    checkState: 'SUCCESS',
    comments: [comment('dev-4', 'A couple of naming notes.')],
    reviews: [{ author: 'dev-4', authorName: null, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-01T09:30:00Z' }],
    reviewRequests: [{ login: 'dev-5', name: null }],
    threads: [
      { isResolved: false, isOutdated: false, comments: [comment('dev-4', 'This name is wrong.')] },
      { isResolved: true, isOutdated: false, comments: [comment('dev-4', 'Settled already.')] },
      { isResolved: false, isOutdated: true, comments: [comment('dev-4', 'Moved on since.')] },
    ],
    ...over,
  };
}

describe('the system prompt', () => {
  it('lists every supported action', () => {
    for (const action of TRIAGE_ACTIONS) {
      expect(TRIAGE_SYSTEM_PROMPT).toContain(`${action}:`);
    }
  });

  it('specifies action precedence', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('take the first that applies');
    // Assert action precedence independently of the prompt.
    const order = ['merge-upstream', 'fix-checks', 'qa-failure', 'qa-question', 'dev-question', 'address-review', 'review-others', 'develop', 'other'];
    const at = order.map((action) => TRIAGE_SYSTEM_PROMPT.indexOf(`${action}:`));

    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(at.every((i) => i > 0)).toBe(true);
  });

  it('defaults assigned issues without discussion or PRs to develop', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('is develop, not other');
  });

  it('uses other only when no listed action fits', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Use other only if no listed action fits.');
  });

  it('requires merge requests and excludes inferred conflict work', () => {
    // Merges require written requests. Failing-check facts are applied before model classification (R39).
    expect(TRIAGE_SYSTEM_PROMPT).toContain('somebody has asked you to merge or rebase the base branch into yours');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('A branch that will not merge is not yours to fix.');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('is failing');
  });

  it('uses the latest report of a problem', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('as pending after someone reports it fixed');
  });

  it('includes the current date', () => {
    expect(buildTriagePrompt(context(), Date.parse('2026-09-05T12:00:00Z'))).toContain('Today is 2026-09-05.');
  });

  it('limits the explanation to 160 characters', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('160 characters');
  });

  it('requests status and responsibility without implementation detail', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Describe the status and who needs to act');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Do not summarise the change');
  });

  it('forbids counts from partial evidence', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Do not give counts in digits or words');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('never "Mayur asked five questions"');
  });

  it('places explanation constraints before action choices', () => {
    // Both rules regressed when they sat at the end: counts came back and the sentence went technical again.
    for (const rule of ['Describe the status and who needs to act', 'Do not give counts']) {
      expect(TRIAGE_SYSTEM_PROMPT.indexOf(rule)).toBeLessThan(TRIAGE_SYSTEM_PROMPT.indexOf('1. merge-upstream'));
    }
  });

  it('uses PR authorship to determine review responsibility', () => {
    // A colleague PR can require review while its parent branch prevents merging.
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Use "Opened by" to identify whose review it is');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('pull request even when it cannot merge yet');
  });

  it('classifies own PRs awaiting review or dependencies as other', () => {
    // Distinguish colleague PRs needing review from own PRs awaiting someone else.
    expect(TRIAGE_SYSTEM_PROMPT).toContain('For your own PR awaiting a reviewer');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('answer other');
    expect(TRIAGE_SYSTEM_PROMPT).not.toContain('awaiting-others');
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

  it('addresses the developer as you', () => {
    const prompt = buildTriagePrompt(
      context({ comments: [comment('dev-1', 'Mine.', 'MEMBER', 'Jon Hynes'), comment('dev-2', 'Theirs.')] }),
      NOW,
    );

    expect(prompt).toContain('you, member');
    expect(prompt).toContain('dev-2, member');
    // Their own name must not appear anywhere: a card that names its reader is a card about somebody else.
    expect(prompt).not.toContain('Jon');
    expect(prompt).not.toContain('dev-1');
  });

  it('matches an own login whatever its case, the way the lane rules do', () => {
    const prompt = buildTriagePrompt(context({ comments: [comment('DEV-1', 'Mine.')], logins: ['dev-1'] }), NOW);

    expect(prompt).toContain('you, member');
    expect(prompt).not.toContain('DEV-1');
  });

  it('calls everybody else by their first name, and falls back to the login where GitHub has none', () => {
    const prompt = buildTriagePrompt(
      context({ comments: [comment('dev-2', 'One.', 'MEMBER', 'Mayur Bhaliya'), comment('dev-3', 'Two.')] }),
      NOW,
    );

    expect(prompt).toContain('Mayur, member');
    expect(prompt).not.toContain('Bhaliya');
    // A bot carries no profile name at all, and bots write much of what appears on a pull request.
    expect(prompt).toContain('dev-3, member');
  });

  it('carries an author association, so a tester reads differently from a colleague', () => {
    expect(buildTriagePrompt(context(), NOW)).toContain('dev-2, contributor');
  });

  it('names the people on a pull request the way it names the people in the conversation', () => {
    const pr = pullRequest({
      author: 'dev-2',
      authorName: 'Mayur Bhaliya',
      reviewRequests: [{ login: 'dev-1', name: null }, { login: 'dev-5', name: 'Bri Fradella' }],
      reviews: [{ author: 'dev-1', authorName: null, state: 'COMMENTED', submittedAt: null }],
    });
    const prompt = buildTriagePrompt(context({ pullRequest: pr }), NOW);

    expect(prompt).toContain('Opened by: Mayur');
    expect(prompt).toContain('Requested reviewers: you, Bri');
    expect(prompt).toContain('Reviews submitted: you COMMENTED');
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
    expect(prompt).toContain('Opened by: you');
    expect(prompt).toContain('State: OPEN');
    expect(prompt).toContain('Requested reviewers: dev-5');
    expect(prompt).toContain('Reviews submitted: dev-4 CHANGES_REQUESTED');
  });

  it('marks a draft, because a draft asks for nothing yet', () => {
    expect(buildTriagePrompt(context({ pullRequest: pullRequest({ isDraft: true }) }), NOW)).toContain('State: OPEN (draft)');
  });

  it('carries only the threads still open, and numbers them without a total', () => {
    const prompt = buildTriagePrompt(context({ pullRequest: pullRequest() }), NOW);

    expect(prompt).toContain('Unresolved review threads (the most recent few):');
    expect(prompt).toContain('Thread 1:');
    expect(prompt).not.toContain('Thread 2:');
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
        pullRequest: pullRequest({ comments: [], reviews: [], reviewRequests: [], threads: [] }),
      }),
      NOW,
    );

    expect(bare).toContain(`${ACTIVITY}\n(none)`);
    expect(bare).toContain('Requested reviewers: (none)');
    expect(bare).toContain('Reviews submitted: (none)');
    expect(bare).toContain('Unresolved review threads (the most recent few):\n(none)');
  });

  it('numbers each open thread, so three threads never read as one thread with three comments', () => {
    const many = pullRequest({
      threads: [
        { isResolved: false, isOutdated: false, comments: [comment('dev-4', 'First point.')] },
        { isResolved: false, isOutdated: false, comments: [comment('dev-5', 'Second point.')] },
      ],
    });
    const prompt = buildTriagePrompt(context({ pullRequest: many }), NOW);

    expect(prompt).toContain('Thread 1:');
    expect(prompt).toContain('Thread 2:');
    expect(prompt.indexOf('Thread 1:')).toBeLessThan(prompt.indexOf('Thread 2:'));
  });

  it('presents no list as a total, because every one of them is capped before it is rendered', () => {
    const many = pullRequest({
      threads: [
        { isResolved: false, isOutdated: false, comments: [comment('dev-4', 'First point.')] },
        { isResolved: false, isOutdated: false, comments: [comment('dev-5', 'Second point.')] },
      ],
    });
    const prompt = buildTriagePrompt(context({ pullRequest: many }), NOW);

    // Partial comment and thread lists must not imply totals.
    for (const heading of prompt.split('\n').filter((line) => line.endsWith(':'))) {
      expect(heading).not.toMatch(/\(\d+\)/);
    }

    expect(prompt).toContain(ACTIVITY);
    expect(prompt).toContain('Recent pull request comments (the most recent few, oldest first):');
    expect(prompt).toContain('Unresolved review threads (the most recent few):');
  });

  it('lists comments and state changes oldest first, as the system prompt specifies', () => {
    const prompt = buildTriagePrompt(
      context({
        status: '🔍 Dev Review',
        comments: [comment('dev-3', 'Rebased.')],
        stateEvents: [moved('2026-09-04T13:53:36Z', 'dev-3', '⚒️ Dev', '🔍 Dev Review'), assigned('2026-09-04T16:28:42Z', 'dev-5', 'dev-1')],
      }),
      NOW,
    );
    const activity = prompt.split(`${ACTIVITY}\n`)[1]!.split('\n\n')[0]!.split('\n');

    expect(TRIAGE_SYSTEM_PROMPT).toContain('Activity is listed oldest first.');
    expect(activity[0]).toContain('dev-3, member on 2026-09-01T09:00:00Z');
    expect(activity[2]).toBe('► dev-3 on 2026-09-04T13:53:36Z: moved the status ⚒️ Dev → 🔍 Dev Review');
    expect(activity[3]).toBe('► dev-5 on 2026-09-04T16:28:42Z: assigned to you');
  });

  it('leads with what the card was last told to be, and says how much of the talk that answered', () => {
    // Comments before the latest state instruction are background.
    const prompt = buildTriagePrompt(
      context({
        status: '🔍 Dev Review',
        comments: [comment('dev-3', 'Should this respect the account time zone?')],
        stateEvents: [moved('2026-09-04T13:53:36Z', 'dev-3', '⚒️ Dev', '🔍 Dev Review'), assigned('2026-09-04T16:28:42Z', 'dev-5', 'dev-1')],
      }),
      NOW,
    );

    expect(prompt).toContain('dev-5 assigned this to you on 2026-09-04T16:28:42Z, status ⚒️ Dev → 🔍 Dev Review.');
    expect(prompt).toContain('No issue comments since this change. Earlier comments are background.');
  });

  it('identifies comments since the latest instruction', () => {
    const prompt = buildTriagePrompt(
      context({
        comments: [{ ...comment('dev-3', 'Actually, one more thing.'), createdAt: '2026-09-04T18:00:00Z' }],
        stateEvents: [assigned('2026-09-04T16:28:42Z', 'dev-5', 'dev-1')],
      }),
      NOW,
    );

    expect(prompt).toContain('Only comments since this change remain open.');
  });

  it('excludes project additions from instructions', () => {
    const prompt = buildTriagePrompt(context({ stateEvents: [moved('2026-08-24T20:41:34Z', 'dev-4', '', '🆕 New')] }), NOW);

    expect(prompt).not.toContain('►');
    expect(prompt).not.toContain('assigned this to you');
  });

  it('names the developer as you wherever a state change touches them, never by login', () => {
    const prompt = buildTriagePrompt(
      context({ stateEvents: [moved('2026-09-04T13:00:00Z', 'dev-1', '🔍 Dev Review', '⚒️ Dev'), assigned('2026-09-04T13:00:04Z', 'dev-1', 'dev-3')] }),
      NOW,
    );

    expect(prompt).toContain('► you on 2026-09-04T13:00:00Z: moved the status 🔍 Dev Review → ⚒️ Dev, assigned to dev-3');
    expect(prompt).toContain('you last changed its state on');
  });

  it('says assigned to you once where the developer and their linked bot were assigned in one act', () => {
    const prompt = buildTriagePrompt(
      context({ stateEvents: [assigned('2026-09-04T13:00:00Z', 'dev-2', 'dev-1'), assigned('2026-09-04T13:00:04Z', 'dev-2', 'dev-1')] }),
      NOW,
    );

    expect(prompt).toContain('► dev-2 on 2026-09-04T13:00:00Z: assigned to you\n');
    expect(prompt).not.toContain('you and you');
  });

  it('tells the model the action where the evidence settled one, and asks for it where it did not', () => {
    expect(buildTriagePrompt(context(), NOW, 'review-others')).toContain(
      'The action is already decided: review-others — Review their PR. Write one sentence explaining that action.',
    );
    expect(buildTriagePrompt(context(), NOW)).toContain('Answer with the action and the sentence.');
  });

  it('is a pure function of its context, so what reached the model can always be read back', () => {
    expect(buildTriagePrompt(context({ pullRequest: pullRequest() }), NOW)).toBe(
      buildTriagePrompt(context({ pullRequest: pullRequest() }), NOW),
    );
  });
});
