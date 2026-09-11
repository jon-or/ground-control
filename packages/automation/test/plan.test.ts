import { describe, expect, it } from 'vitest';
import type {
  ActionSettings,
    LaneId,
  TriageContext,
  TriagePullRequest,
} from '@ground-control/core';
import { actionEnabled, planAction, promptFor } from '../src/plan.js';
import { actionEvidence } from '../src/evidence.js';


function settings(over: Partial<ActionSettings> = {}): ActionSettings {
  return {
    permissionMode: 'manual',
    concurrency: 1,
    dailyLimit: 10,
    fromBrowser: false,
    resultTimeoutMs: 1_800_000,
    actions: { 'merge-upstream': { enabled: true, prompt: '/or-merge {base} {branch} {issue} --single' } },
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
    settings?: ActionSettings;
    context?: Partial<TriageContext>;
  } = {},
) {
  return planAction({
    action: 'merge-upstream',
    context: context(pr, over.context ?? {}),
    lane: over.lane ?? 'review',
    liveSessions: over.liveSessions ?? 0,
    settings: over.settings ?? settings(),
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
      action: 'merge-upstream',
      evidence: '17198|4021|9ab0cde1111111111111111111111111111111ff',
      repository: 'example-org/example-repo',
      issueNumber: 17198,
      pullRequest: 4021,
      branch: '17198-channel-mapping',
      base: 'master',
    });
  });

  /** The requested action supplies merge intent; eligibility does not derive a merge from branch state (R39). */
  it('plans the action it was given rather than deciding one from mergeability', () => {
    expect(plan()).toMatchObject({ plan: { action: 'merge-upstream' } });
    expect(plan({ checkState: 'FAILURE' })).toMatchObject({ plan: { action: 'merge-upstream' } });
    expect(plan({ checkState: 'SUCCESS' })).toMatchObject({ plan: { action: 'merge-upstream' } });
  });

  /** The whole of the multi-leg case: merging the default branch into a stacked branch is the wrong merge. */
  it('refuses a pull request based on anything but the repository default branch', () => {
    expect(refusedAs(plan({ baseRefName: '17000-parent-feature' }))).toBe('stacked-branch');
    expect(plan({ baseRefName: '17000-parent-feature' })).toMatchObject({
      refusal: { message: '#4021 targets 17000-parent-feature. Merge-upstream requires the default branch, master.' },
    });
  });

  it('refuses when it could not read which branch the repository merges into', () => {
    expect(refusedAs(plan({}, { context: { defaultBranch: null } }))).toBe('no-default-branch');
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
    expect(refusedAs(plan({}, { lane: 'done' }))).toBe('lane-parked');
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
    expect(
      actionEnabled('merge-upstream', settings({ actions: { 'merge-upstream': { enabled: false, prompt: '/x' } } })),
    ).toBe(false);
    expect(
      actionEnabled('merge-upstream', settings({ actions: { 'merge-upstream': { enabled: true, prompt: '   ' } } })),
    ).toBe(false);
  });

  it('is on only for an action turned on with something to run', () => {
    expect(actionEnabled('merge-upstream', settings())).toBe(true);
  });

  it('treats whitespace-only prompts as missing', () => {
    expect(promptFor('merge-upstream', settings({ actions: { 'merge-upstream': { enabled: true, prompt: ' ' } } }))).toBe(null);
    expect(promptFor('merge-upstream', settings())).toBe('/or-merge {base} {branch} {issue} --single');
    expect(promptFor('merge-upstream', settings({ actions: {} }))).toBe(null);
  });
});
