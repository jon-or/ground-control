import { describe, expect, it } from 'vitest';
import type { TriageContext } from '@ground-control/core';
import { TRIAGE_SYSTEM_PROMPT, buildTriagePrompt } from '../src/triagePrompt.js';
import { CLASSIFIED_ACTIONS, TRIAGE_ACTIONS } from '../src/triage.js';

/**
 * The one action the model is never offered. It may report a problem somebody named — an auto-merge that failed, a
 * red build — because `mergeable` reads UNKNOWN in the window a card arrives; only the hub says everything is fine.
 */
const NEVER_OFFERED = ['land'];

const NOW = Date.parse('2026-09-05T12:00:00Z');

function comment(author: string, body: string, association = 'MEMBER', authorName: string | null = null) {
  return { author, authorName, authorAssociation: association, body, createdAt: '2026-09-01T09:00:00Z' };
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
    authorName: null,
    reviewDecision: 'CHANGES_REQUESTED',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
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
  it('names every action the model decides, and none the hub reads for itself', () => {
    for (const action of TRIAGE_ACTIONS) {
      expect(TRIAGE_SYSTEM_PROMPT.includes(`${action}:`)).toBe(!NEVER_OFFERED.includes(action));
    }
  });

  it('gives an order to take when more than one fits, since several routinely do', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('take the first that applies');
    // The order the numbers put them in, which is the whole of what the rule is worth.
    const order = ['resolve-conflicts', 'merge-upstream', 'fix-checks', 'uat-failure', 'uat-question', 'answer-design-question', 'address-review', 'review-others', 'begin-work', 'other'];
    const at = order.map((action) => TRIAGE_SYSTEM_PROMPT.indexOf(`${action}:`));

    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(at.every((i) => i > 0)).toBe(true);
  });

  it('says an assigned issue with nothing on it is begin-work, since that is most of a first run', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('is begin-work, not other');
  });

  it('counts the actions above other the way the list does, so retiring one cannot leave the prose wrong', () => {
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'];

    expect(TRIAGE_SYSTEM_PROMPT).toContain(`none of the ${words[CLASSIFIED_ACTIONS.length - 1]} above fits`);
  });

  it('names a conflict, a stale branch and a red build, which are reported in words long before GitHub computes them', () => {
    // A card arrives in the very window `mergeable` reads UNKNOWN, so without these the commonest thing anybody
    // writes on a pull request — that the auto-merge failed — has nowhere to go.
    expect(TRIAGE_SYSTEM_PROMPT).toContain('auto-merge failed');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('merge or rebase the base branch in');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('is failing');
  });

  it('tells the model to take the most recent word on a problem, so a fixed one is not still pending', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('since said is fixed is not what the card is waiting on');
  });

  it('tells the model what day it is, since three of the actions turn on recency', () => {
    expect(buildTriagePrompt(context(), Date.parse('2026-09-05T12:00:00Z'))).toContain('Today is 2026-09-05.');
  });

  it('asks for the one sentence length the parser enforces', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('160 characters');
  });

  it('asks for logistics rather than a summary of the change, which is what the developer already knows', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('logistics, not engineering');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Do not summarise the change');
  });

  it('forbids a count in words as well as digits, since the reading that started this said "all nine findings"', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('Count nothing, in digits or in words');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('never "Mayur asked five questions"');
  });

  it('states how to write the sentence before it lists the actions, which is where the rule holds', () => {
    // Both rules regressed when they sat at the end: counts came back and the sentence went technical again.
    for (const rule of ['logistics, not engineering', 'Count nothing']) {
      expect(TRIAGE_SYSTEM_PROMPT.indexOf(rule)).toBeLessThan(TRIAGE_SYSTEM_PROMPT.indexOf('1. resolve-conflicts'));
    }
  });

  it('gives the board status the last word over the conversation, and lets Opened by decide whose review it is', () => {
    // A colleague's pull request, stacked on a parent, on an issue at Dev Review: what it waits on to merge is not
    // what the card waits on, and without this every such card read as blocked on somebody else.
    expect(TRIAGE_SYSTEM_PROMPT).toContain('it outranks the conversation');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('"Opened by" says whose job that is');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('review even when it cannot merge yet');
  });

  it('gives an unreviewed or blocked pull request nowhere to go but other, so no card claims to be waiting', () => {
    // Both misreadings the removed action produced: a colleague's stacked pull request awaiting its parent, and the
    // developer's own awaiting a reviewer while the issue had already been handed back to them.
    expect(TRIAGE_SYSTEM_PROMPT).toContain("is somebody else's queue");
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

  it('writes the developer as you and never as a name, because the sentence is addressed to them', () => {
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

  it('takes a name override above the profile, since an agent account profile names the agent', () => {
    const over = { 'dev-2': 'Chris' };
    const prompt = buildTriagePrompt(context({ comments: [comment('dev-2', 'One.', 'MEMBER', 'Friday')] }), NOW, over);

    expect(prompt).toContain('Chris, member');
    expect(prompt).not.toContain('Friday');
    // Matched however the login is cased, the way every other login comparison here is.
    expect(buildTriagePrompt(context({ comments: [comment('DEV-2', 'One.')] }), NOW, over)).toContain('Chris, member');
  });

  it('never lets an override rename the developer, who is you whatever anybody calls them', () => {
    const prompt = buildTriagePrompt(context({ comments: [comment('dev-1', 'Mine.')] }), NOW, { 'dev-1': 'Chris' });

    expect(prompt).toContain('you, member');
    expect(prompt).not.toContain('Chris');
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
    expect(prompt).toContain('Reviewers asked for: you, Bri');
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
    expect(prompt).toContain('Review decision: CHANGES_REQUESTED');
    expect(prompt).toContain('Reviewers asked for: dev-5');
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
        pullRequest: pullRequest({ comments: [], reviews: [], reviewRequests: [], threads: [], reviewDecision: null }),
      }),
      NOW,
    );

    expect(bare).toContain('Recent issue comments (the most recent few, oldest first):\n(none)');
    expect(bare).toContain('Review decision: (none)');
    expect(bare).toContain('Reviewers asked for: (none)');
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

    // Every heading, not just the one that carried a count: a number beside a truncated list is a number the model
    // will repeat, and `reviewThreads(last:5)` means the number was never the total in the first place.
    for (const heading of prompt.split('\n').filter((line) => line.endsWith(':'))) {
      expect(heading).not.toMatch(/\(\d+\)/);
    }

    expect(prompt).toContain('Recent issue comments (the most recent few, oldest first):');
    expect(prompt).toContain('Recent pull request comments (the most recent few, oldest first):');
    expect(prompt).toContain('Unresolved review threads (the most recent few):');
  });

  it('is a pure function of its context, so what reached the model can always be read back', () => {
    expect(buildTriagePrompt(context({ pullRequest: pullRequest() }), NOW)).toBe(
      buildTriagePrompt(context({ pullRequest: pullRequest() }), NOW),
    );
  });
});
