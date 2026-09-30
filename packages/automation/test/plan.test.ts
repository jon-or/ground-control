import { describe, expect, it } from 'vitest';
import type {
  ActionRow,
  BranchPullRequest,
  LaneId,
  TriageContext,
  TriagePullRequest,
  TriageQualifier,
} from '@ground-control/core';
import { actionEnabled, needsBaseMerge, planAction, planBaseMerge, promptFor } from '../src/plan.js';
import { actionEvidence } from '../src/evidence.js';


function row(over: Partial<ActionRow> = {}): ActionRow {
  return {
    action: 'merge',
    qualifier: 'upstream',
    prompt: '/or-merge {base} {branch} {issue} --single',
    automatic: true,
    ...over,
  };
}

function pullRequest(over: Partial<TriagePullRequest> = {}): TriagePullRequest {
  return {
    number: 4021,
    title: 'Fix paging',
    body: '',
    state: 'OPEN',
    isDraft: false,
    author: 'dev-1',
    authorName: null,
    baseRefName: 'master',
    headRefName: '17198-channel-mapping',
    headOid: '9ab0cde1111111111111111111111111111111ff',
    checkState: 'SUCCESS',
    comments: [],
    reviews: [],
    reviewRequests: [],
    threads: [],
    ...over,
  };
}

function context(pr: Partial<TriagePullRequest> | null = {}, over: Partial<TriageContext> = {}): TriageContext {
  return {
    issueNumber: 17198,
    title: 'Channel mapping drops rows past the first page',
    body: '',
    status: '⚒️ Dev',
    stateEvents: [],
    comments: [],
    pullRequest: pr === null ? null : pullRequest(pr),
    assignees: ['dev-1'],
    logins: ['dev-1', 'dev-1-bot'],
    repository: 'example-org/example-repo',
    defaultBranch: 'master',
    ...over,
  };
}

function plan(
  pr: Partial<TriagePullRequest> | null = {},
  over: {
    lane?: LaneId;
    liveSessions?: number;
    qualifier?: TriageQualifier | null;
    context?: Partial<TriageContext>;
  } = {},
) {
  return planAction({
    action: 'merge',
    qualifier: over.qualifier === undefined ? 'upstream' : over.qualifier,
    target: null,
    context: context(pr, over.context ?? {}),
    lane: over.lane ?? 'review',
    liveSessions: over.liveSessions ?? 0,
    testBranchPattern: '^Test-',
  });
}

/** What every refusal test asserts on, so a passing test cannot be one that refused for the wrong reason. */
function refusedAs(decision: ReturnType<typeof plan>): string {
  return decision.ok ? 'ok' : decision.refusal.kind;
}

describe('what the board will act on', () => {
  it('plans the merge from the pull request itself, never from a convention', () => {
    const decision = plan();

    expect(decision.ok).toBe(true);
    expect(decision.ok && decision.plan).toEqual({
      action: 'merge',
      qualifier: 'upstream',
      evidence: '17198|4021|9ab0cde1111111111111111111111111111111ff',
      repository: 'example-org/example-repo',
      issueNumber: 17198,
      pullRequest: 4021,
      branch: '17198-channel-mapping',
      base: 'master',
      defaultBranch: 'master',
      target: '',
      role: 'author',
      defaultOid: '',
    });
  });

  /** The requested action supplies merge intent; eligibility does not derive a merge from branch state (R39). */
  it('plans the action it was given rather than deciding one from mergeability', () => {
    expect(plan()).toMatchObject({ plan: { action: 'merge' } });
    expect(plan({ checkState: 'FAILURE' })).toMatchObject({ plan: { action: 'merge' } });
    expect(plan({ checkState: 'SUCCESS' })).toMatchObject({ plan: { action: 'merge' } });
  });

  /** A base other than the default branch makes the merge stacked; the row was chosen for the type read earlier. */
  it('refuses a stacked pull request read as an upstream merge, and plans it read as a stacked one', () => {
    expect(refusedAs(plan({ baseRefName: '17000-parent-feature' }))).toBe('merge-type-changed');
    expect(plan({ baseRefName: '17000-parent-feature' })).toMatchObject({
      refusal: { message: 'This is now a stacked merge, not the upstream merge the card was read as. Read the card again.' },
    });
    expect(plan({ baseRefName: '17000-parent-feature' }, { qualifier: 'stacked' })).toMatchObject({
      ok: true,
      plan: { qualifier: 'stacked', base: '17000-parent-feature', defaultBranch: 'master' },
    });
  });

  it('refuses when it could not read which branch the repository merges into', () => {
    expect(refusedAs(plan({}, { context: { defaultBranch: null } }))).toBe('merge-type-unknown');
    expect(plan({}, { context: { defaultBranch: null } })).toMatchObject({
      refusal: { message: 'Repository default branch unavailable.' },
    });
  });

  it('refuses a draft, a closed one, and one that is not the developer own', () => {
    expect(refusedAs(plan({ isDraft: true }))).toBe('pull-request-draft');
    expect(refusedAs(plan({ state: 'MERGED' }))).toBe('pull-request-closed');
    expect(refusedAs(plan({ author: 'dev-2' }))).toBe('pull-request-not-yours');
    expect(refusedAs(plan({ author: null }))).toBe('pull-request-not-yours');
  });

  it('takes a pull request opened under any of the developer accounts as theirs', () => {
    expect(plan({ author: 'DEV-1-BOT' }).ok).toBe(true);
  });

  it('refuses a card with no pull request at all', () => {
    expect(refusedAs(plan(null))).toBe('no-pull-request');
  });

  /** R8 keeps placement for the developer; a merge started in a lane they parked the card in overrules them. */
  it('refuses in the lanes the developer parked the card in, and acts in the others', () => {
    expect(refusedAs(plan({}, { lane: 'icebox' }))).toBe('lane-parked');
    expect(refusedAs(plan({}, { lane: 'archived' }))).toBe('lane-parked');
    expect(plan({}, { lane: 'build' }).ok).toBe(true);
    expect(plan({}, { lane: 'unstarted' }).ok).toBe(true);
  });

  /** R18: never a second agent on one piece of work, and a run in flight is itself a session on the card. */
  it('refuses a card something is already working on', () => {
    expect(refusedAs(plan({}, { liveSessions: 1 }))).toBe('session-running');
  });

  it('refuses a pull request whose head branch it could not read', () => {
    expect(refusedAs(plan({ headRefName: '' }))).toBe('no-head-branch');
  });
});

describe('which pull requests each action is for', () => {
  function planned(action: 'review-others' | 'address-review', pr: Partial<TriagePullRequest>, qualifier: TriageQualifier = 'initial') {
    return planAction({ action, qualifier, target: null, context: context(pr), lane: 'review', liveSessions: 0, testBranchPattern: '^Test-' });
  }

  it('reviews someone else’s pull request as its reviewer, and refuses to review the developer’s own', () => {
    expect(planned('review-others', { author: 'dev-2' })).toMatchObject({
      ok: true,
      plan: { action: 'review-others', qualifier: 'initial', role: 'reviewer', pullRequest: 4021, branch: '17198-channel-mapping' },
    });
    expect(planned('review-others', {})).toMatchObject({
      refusal: { kind: 'pull-request-yours', message: 'Pull request #4021 is yours, so there is no review of it to do.' },
    });
  });

  it('answers a review of the developer’s own pull request only', () => {
    expect(planned('address-review', {}, 'followup')).toMatchObject({ ok: true, plan: { qualifier: 'followup', role: 'author', target: '' } });
    expect(refusedAs(planned('address-review', { author: 'dev-2' }))).toBe('pull-request-not-yours');
  });

  it('refuses a draft for every action, since a draft is not asking for review yet', () => {
    expect(refusedAs(planned('review-others', { author: 'dev-2', isDraft: true }))).toBe('pull-request-draft');
  });
});

describe('a merge into a test branch', () => {
  function merged(target: string | null, pr: Partial<TriagePullRequest> = {}, qualifier: TriageQualifier | null = 'test') {
    return planAction({ action: 'merge', qualifier, target, context: context(pr), lane: 'build', liveSessions: 0, testBranchPattern: '^Test-' });
  }

  it('names the test branch the request named, stacked or not', () => {
    expect(merged('Test-Payments')).toMatchObject({ ok: true, plan: { qualifier: 'test', target: 'Test-Payments', base: 'master' } });
    expect(merged('Test-Payments', { baseRefName: '17000-parent-feature' })).toMatchObject({
      ok: true,
      plan: { target: 'Test-Payments', base: '17000-parent-feature', defaultBranch: 'master' },
    });
  });

  it('refuses a branch that is neither the pull request’s nor a test branch, and one read as another type', () => {
    expect(merged('release-9')).toMatchObject({
      refusal: { kind: 'merge-type-unknown', message: 'The request names release-9, which is neither this pull request\'s branch, its base, nor a test branch.' },
    });
    expect(refusedAs(merged(null))).toBe('merge-type-changed');
  });

  // A row with no qualifier takes any merge, so there is no reading to disagree with.
  it('plans whatever type the branches give where the reading named none', () => {
    expect(merged('Test-Payments', {}, null)).toMatchObject({ ok: true, plan: { qualifier: null, target: 'Test-Payments' } });
  });
});

describe('what evidence a run is authorised against', () => {
  it('moves when the head commit moves, so a push makes the card eligible again', () => {
    expect(actionEvidence(context())).not.toBe(actionEvidence(context({ headOid: 'ffff' })));
  });

  /** Base-branch changes must not authorize another run against the same PR head. */
  it('does not move for anything else about the card', () => {
    expect(actionEvidence(context({ checkState: 'FAILURE' }, { title: 'renamed', status: '🔍 Dev Review' }))).toBe(
      actionEvidence(context()),
    );
  });

  it('is stable for a card with no pull request', () => {
    expect(actionEvidence(context(null))).toBe('17198||');
  });
});

describe('whether an action is turned on', () => {
  it('is off for an action turned off, and one with nothing to run', () => {
    expect(actionEnabled(row({ automatic: false, prompt: '/x' }))).toBe(false);
    expect(actionEnabled(row({ automatic: true, prompt: '   ' }))).toBe(false);
  });

  it('is on only for an action turned on with something to run', () => {
    expect(actionEnabled(row())).toBe(true);
  });

  it('treats whitespace-only prompts as missing', () => {
    expect(promptFor(row({ prompt: ' ' }))).toBe(null);
    expect(promptFor(row())).toBe('/or-merge {base} {branch} {issue} --single');
    expect(promptFor(undefined)).toBe(null);
  });
});

/** The base of a stacked pull request is merged into first, only where it is the developer's own and one level deep (R39). */
describe('the base merge a stacked merge runs first', () => {
  const stacked = () => {
    const decision = plan({ baseRefName: '17000-parent-feature' }, { qualifier: 'stacked', context: { defaultOid: 'd0d0d0d' } });

    if (!decision.ok) throw new Error(decision.refusal.message);

    return decision.plan;
  };

  function base(over: Partial<BranchPullRequest> = {}): BranchPullRequest {
    return {
      number: 4000,
      author: 'dev-1-bot',
      isDraft: false,
      baseRefName: 'master',
      headRefName: '17000-parent-feature',
      headOid: 'b1b1b1b',
      issueNumber: null,
      crossRepository: false,
      ...over,
    };
  }

  const byName = (branch: string) => (/^(\d+)-/.exec(branch) ? Number(/^(\d+)-/.exec(branch)![1]) : null);

  it('needs one only where the pull request is based on another branch', () => {
    expect(needsBaseMerge(stacked())).toBe(true);
    expect(needsBaseMerge((plan() as { ok: true; plan: ReturnType<typeof stacked> }).plan)).toBe(false);
  });

  it('takes the base pull request\'s facts, its issue from the one it closes, else from the branch name', () => {
    expect(planBaseMerge(stacked(), [base({ issueNumber: 16999 })], ['dev-1', 'dev-1-bot'], byName)).toEqual({
      ok: true,
      plan: {
        repository: 'example-org/example-repo',
        issueNumber: 16999,
        pullRequest: 4000,
        branch: '17000-parent-feature',
        defaultBranch: 'master',
        headOid: 'b1b1b1b',
      },
    });
    expect(planBaseMerge(stacked(), [base()], ['dev-1-bot'], byName)).toMatchObject({ ok: true, plan: { issueNumber: 17000 } });
  });

  it.each([
    ['no open pull request', [], 'base-no-pull-request'],
    ['only a fork\'s pull request', [base({ crossRepository: true })], 'base-no-pull-request'],
    ['several pull requests', [base(), base({ number: 4001 })], 'base-several-pull-requests'],
    ['someone else\'s pull request', [base({ author: 'someone-else' })], 'base-not-yours'],
    ['a draft', [base({ isDraft: true })], 'base-draft'],
    ['a base that is itself stacked', [base({ baseRefName: '16000-grandparent' })], 'base-stacked'],
    ['no commit', [base({ headOid: '' })], 'base-no-tip'],
  ])('refuses %s', (_name, found, kind) => {
    const decision = planBaseMerge(stacked(), found, ['dev-1', 'dev-1-bot'], byName);

    expect(decision.ok ? 'ok' : decision.refusal.kind).toBe(kind);
  });

  it('refuses a base whose issue neither its pull request nor its name gives', () => {
    const decision = planBaseMerge(stacked(), [base()], ['dev-1-bot'], () => null);

    expect(decision.ok ? 'ok' : decision.refusal.kind).toBe('base-no-issue');
  });
});

describe('develop and ship, which work on the issue (R49)', () => {
  function workflow(action: 'develop' | 'ship', pr: Partial<TriagePullRequest> | null, over: { lane?: LaneId; liveSessions?: number } = {}) {
    return planAction({
      action,
      qualifier: null,
      target: null,
      context: context(pr),
      lane: over.lane ?? 'unstarted',
      liveSessions: over.liveSessions ?? 0,
      testBranchPattern: '^Test-',
    });
  }

  it('develops an issue with no pull request, leaving the pull request facts empty', () => {
    const decision = workflow('develop', null);

    expect(decision.ok && decision.plan).toEqual({
      action: 'develop',
      qualifier: null,
      evidence: '17198||',
      repository: 'example-org/example-repo',
      issueNumber: 17198,
      pullRequest: null,
      branch: '',
      base: '',
      defaultBranch: 'master',
      target: '',
      role: 'author',
      defaultOid: '',
    });
  });

  it('fills the prompt from the developer’s own open pull request, and ignores anyone else’s', () => {
    const own = workflow('ship', {}, { lane: 'review' });
    const theirs = workflow('ship', { author: 'someone-else' }, { lane: 'review' });
    const draft = workflow('ship', { isDraft: true }, { lane: 'review' });

    expect(own.ok && [own.plan.pullRequest, own.plan.branch]).toEqual([4021, '17198-channel-mapping']);
    expect(theirs.ok && [theirs.plan.pullRequest, theirs.plan.branch]).toEqual([null, '']);
    // A draft is the developer's own work in progress; shipping marks it ready.
    expect(draft.ok && draft.plan.pullRequest).toBe(4021);
  });

  it('refuses while a session counts against it, and in a parked lane', () => {
    expect(refusedAs(workflow('develop', null, { liveSessions: 1 }))).toBe('session-running');
    const busy = workflow('ship', null, { liveSessions: 1 });

    expect(busy.ok ? 'ok' : busy.refusal.message).toBe('A session on this card is still working or waiting.');
    expect(refusedAs(workflow('develop', null, { lane: 'icebox' }))).toBe('lane-parked');
  });
});

describe('answering QA, which works on the issue (R39)', () => {
  function qa(action: 'qa-failure' | 'qa-question', pr: Partial<TriagePullRequest> | null, over: { lane?: LaneId; liveSessions?: number } = {}) {
    return planAction({
      action,
      qualifier: null,
      target: null,
      context: context(pr),
      lane: over.lane ?? 'review',
      liveSessions: over.liveSessions ?? 0,
      testBranchPattern: '^Test-',
    });
  }

  it('answers QA on an issue whose pull request is merged or absent, and fills the prompt from the developer’s own open one', () => {
    const own = qa('qa-failure', {});
    const merged = qa('qa-failure', { state: 'MERGED' });
    const none = qa('qa-question', null);

    expect(own.ok && [own.plan.action, own.plan.pullRequest, own.plan.branch]).toEqual(['qa-failure', 4021, '17198-channel-mapping']);
    expect(merged.ok && [merged.plan.pullRequest, merged.plan.branch]).toEqual([null, '']);
    expect(none.ok && [none.plan.action, none.plan.pullRequest]).toEqual(['qa-question', null]);
  });

  it('refuses while a session is running on the card, and in a parked lane', () => {
    expect(refusedAs(qa('qa-failure', {}, { liveSessions: 1 }))).toBe('session-running');
    expect(refusedAs(qa('qa-question', {}, { lane: 'icebox' }))).toBe('lane-parked');
  });
});
