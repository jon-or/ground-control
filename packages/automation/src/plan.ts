import { mergeTypeOf } from '@ground-control/core';
import type {
  ActionRow,
  AutomatableAction,
  BranchPullRequest,
  LaneId,
  TriageContext,
  TriageQualifier,
} from '@ground-control/core';
import { actionEvidence } from './evidence.js';

/** Specific action refusal and remedy (R25). */
export interface ActionRefusal {
  kind: string;
  message: string;
}

/** Whose pull request the card's is, which decides how its worktree is made (R46). */
export type PullRequestRole = 'author' | 'reviewer';

/** Validated dispatch facts from fresh context. The directory the run works in is the card's worktree (R46). */
export interface ActionPlan {
  action: AutomatableAction;
  qualifier: TriageQualifier | null;
  evidence: string;
  repository: string;
  issueNumber: number;
  pullRequest: number;
  /** PR head branch. */
  branch: string;
  /** PR base branch. */
  base: string;
  /** Repository default branch, where every merge leg starts. */
  defaultBranch: string;
  /** The test branch a test merge ends in; empty otherwise. */
  target: string;
  role: PullRequestRole;
  /** The default branch's tip when the card was read; empty where the source does not read it. */
  defaultOid: string;
}

export type ActionDecision = { ok: true; plan: ActionPlan } | { ok: false; refusal: ActionRefusal };

/** Disable actions in Icebox and Archived to respect placement and membership (R7-R9). */
const INACTIVE_LANES: readonly LaneId[] = ['icebox', 'archived'];

function refuse(kind: string, message: string): ActionDecision {
  return { ok: false, refusal: { kind, message } };
}

export function isDeveloperLogin(login: string | null, logins: readonly string[]): boolean {
  return login !== null && logins.some((developerLogin) => developerLogin.toLowerCase() === login.toLowerCase());
}

export interface PlanInput {
  /** The reading's action and qualifier; stale branches alone do not authorize merging (R39). */
  action: AutomatableAction;
  qualifier: TriageQualifier | null;
  /** The destination a merge request named, as triage read it. */
  target: string | null;
  context: TriageContext;
  lane: LaneId;
  /** Refuse unattended actions while any session is still running on the card (R39). */
  liveSessions: number;
  testBranchPattern: string;
}

/** Check fresh context for dispatch eligibility. Return the first, most specific refusal. */
export function planAction(input: PlanInput): ActionDecision {
  const { action, context, lane, liveSessions } = input;
  const pr = context.pullRequest;

  if (INACTIVE_LANES.includes(lane)) {
    return refuse('lane-parked', `Card actions are disabled in ${lane}.`);
  }

  if (pr === null) {
    return refuse('no-pull-request', 'This card has no pull request.');
  }

  if (pr.state !== 'OPEN') {
    return refuse('pull-request-closed', `Pull request #${pr.number} is ${pr.state.toLowerCase()}.`);
  }

  if (pr.isDraft) {
    return refuse('pull-request-draft', `Pull request #${pr.number} is a draft.`);
  }

  const mine = isDeveloperLogin(pr.author, context.logins);

  // A review is of someone else's work; merging and answering a review are the author's (R39).
  if (action === 'review-others' && mine) {
    return refuse('pull-request-yours', `Pull request #${pr.number} is yours, so there is no review of it to do.`);
  }

  if (action !== 'review-others' && !mine) {
    return refuse('pull-request-not-yours', `Pull request #${pr.number} is not yours.`);
  }

  if (pr.headRefName === '') {
    return refuse('no-head-branch', `Head branch unavailable for #${pr.number}.`);
  }

  let target = '';

  if (action === 'merge') {
    const merge = mergeTypeOf(pr, context.defaultBranch, input.target, input.testBranchPattern);

    if (!merge.ok) {
      return refuse('merge-type-unknown', merge.reason);
    }

    // The row was chosen by the reading's type; a base that moved since would run the wrong legs.
    if (input.qualifier !== null && merge.type !== input.qualifier) {
      return refuse(
        'merge-type-changed',
        `This is now a ${merge.type} merge, not the ${input.qualifier} merge the card was read as. Read the card again.`,
      );
    }

    target = merge.target ?? '';
  }

  if (liveSessions > 0) {
    return refuse('session-running', 'This card has an active session.');
  }

  return {
    ok: true,
    plan: {
      action,
      qualifier: input.qualifier,
      evidence: actionEvidence(context),
      repository: context.repository,
      issueNumber: context.issueNumber,
      pullRequest: pr.number,
      branch: pr.headRefName,
      base: pr.baseRefName,
      // mergeTypeOf refused an unknown default branch for a merge; other rows only pass it to the prompt.
      defaultBranch: context.defaultBranch ?? '',
      target,
      role: mine ? 'author' : 'reviewer',
      defaultOid: context.defaultOid ?? '',
    },
  };
}

/** Whether a merge must first merge the default branch into the pull request's base, in the base's worktree (R39). */
export function needsBaseMerge(plan: ActionPlan): boolean {
  return plan.action === 'merge' && plan.base !== '' && plan.base !== plan.defaultBranch;
}

/** The base merge a stacked merge runs first: the base's pull request, as the prompt's placeholders take it (R39). */
export interface BasePlan {
  repository: string;
  issueNumber: number;
  pullRequest: number;
  /** The card's base: the branch this merge goes into. */
  branch: string;
  defaultBranch: string;
  /** The base's tip before the merge. */
  headOid: string;
}

export type BaseDecision = { ok: true; plan: BasePlan } | { ok: false; refusal: ActionRefusal };

/**
 * Check the pull requests whose head is the card's base. Only the developer's own open pull request, based on the
 * default branch, is merged into: a push to another person's branch is not the developer's to make, and a longer
 * chain is left to the developer.
 */
export function planBaseMerge(
  plan: ActionPlan,
  found: readonly BranchPullRequest[],
  logins: readonly string[],
  issueOfBranch: (branch: string) => number | null,
): BaseDecision {
  const base = plan.base;
  const same = found.filter((pr) => !pr.crossRepository);

  if (same.length === 0) {
    return refuseBase('base-no-pull-request', `${base} has no open pull request, so the board cannot merge ${plan.defaultBranch} into it.`);
  }

  if (same.length > 1) {
    return refuseBase('base-several-pull-requests', `${base} is the head of ${same.length} open pull requests; merge ${plan.defaultBranch} into it by hand.`);
  }

  const pr = same[0]!;

  if (!isDeveloperLogin(pr.author, logins)) {
    return refuseBase('base-not-yours', `${base} belongs to pull request #${pr.number}, which is not yours.`);
  }

  if (pr.isDraft) {
    return refuseBase('base-draft', `${base} belongs to pull request #${pr.number}, which is a draft.`);
  }

  if (pr.baseRefName !== plan.defaultBranch) {
    return refuseBase('base-stacked', `${base} is itself based on ${pr.baseRefName}; merge that chain by hand.`);
  }

  const issueNumber = pr.issueNumber ?? issueOfBranch(base);

  if (issueNumber === null) {
    return refuseBase('base-no-issue', `No issue could be found for ${base}: pull request #${pr.number} closes none, and the branch name holds no issue number.`);
  }

  if (pr.headOid === '') {
    return refuseBase('base-no-tip', `GitHub gave no commit for ${base}.`);
  }

  return {
    ok: true,
    plan: { repository: plan.repository, issueNumber, pullRequest: pr.number, branch: base, defaultBranch: plan.defaultBranch, headOid: pr.headOid },
  };
}

function refuseBase(kind: string, message: string): BaseDecision {
  return { ok: false, refusal: { kind, message } };
}

/** Whether the row starts without a click: marked automatic, with a nonempty prompt. */
export function actionEnabled(row: ActionRow | undefined): boolean {
  return row !== undefined && row.automatic && row.prompt.trim().length > 0;
}

/** The row's prompt, or null where it has none. Repository workflow has no shipped prompt default. */
export function promptFor(row: ActionRow | undefined): string | null {
  const prompt = row?.prompt.trim() ?? '';

  return prompt.length > 0 ? prompt : null;
}
