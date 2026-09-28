import { mergeTypeOf } from '@ground-control/core';
import type {
  ActionRow,
  AutomatableAction,
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
    },
  };
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
