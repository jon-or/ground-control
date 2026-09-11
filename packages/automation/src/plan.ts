import type {
  ActionSettings,
  AutomatableAction,
  LaneId,
  TriageContext,
} from '@ground-control/core';
import { actionEvidence } from './evidence.js';

/** Specific action refusal and remedy (R25). */
export interface ActionRefusal {
  kind: string;
  message: string;
}

/** Validated dispatch facts from fresh context. The directory the run works in is the card's worktree (R46). */
export interface ActionPlan {
  action: AutomatableAction;
  evidence: string;
  repository: string;
  issueNumber: number;
  pullRequest: number;
  /** Head branch receiving the merge. */
  branch: string;
  /** Verified repository default branch to merge from. */
  base: string;
}

export type ActionDecision = { ok: true; plan: ActionPlan } | { ok: false; refusal: ActionRefusal };

/** Disable actions in Done, Icebox, and Archived to respect placement and membership (R7-R9). */
const INACTIVE_LANES: readonly LaneId[] = ['done', 'icebox', 'archived'];

function refuse(kind: string, message: string): ActionDecision {
  return { ok: false, refusal: { kind, message } };
}

function isDeveloperLogin(login: string | null, logins: readonly string[]): boolean {
  return login !== null && logins.some((developerLogin) => developerLogin.toLowerCase() === login.toLowerCase());
}

export interface PlanInput {
  /** Requested action; stale branches alone do not authorize merging (R39). */
  action: AutomatableAction;
  context: TriageContext;
  lane: LaneId;
  /** Refuse unattended actions while any session is already on the card (R39). */
  liveSessions: number;
  settings: ActionSettings;
}

/** Check fresh context for dispatch eligibility. Return the first, most specific refusal. */
export function planAction(input: PlanInput): ActionDecision {
  const { action, context, lane, liveSessions } = input;
  const pr = context.pullRequest;

  if (INACTIVE_LANES.includes(lane)) {
    return refuse('lane-parked', `Card actions are disabled in ${lane}.`);
  }

  if (pr === null) {
    return refuse('no-pull-request', 'This card has no pull request to merge into.');
  }

  if (pr.state !== 'OPEN') {
    return refuse('pull-request-closed', `Pull request #${pr.number} is ${pr.state.toLowerCase()}.`);
  }

  if (pr.isDraft) {
    return refuse('pull-request-draft', `Pull request #${pr.number} is a draft.`);
  }

  if (!isDeveloperLogin(pr.author, context.logins)) {
    return refuse('pull-request-not-yours', `Pull request #${pr.number} is not yours to merge.`);
  }

  if (context.defaultBranch === null) {
    return refuse('no-default-branch', 'Repository default branch unavailable.');
  }

  // Refuse stacked branches because the parent branch may need updating first (R39).
  if (pr.baseRefName !== context.defaultBranch) {
    return refuse(
      'stacked-branch',
      `#${pr.number} targets ${pr.baseRefName}. Merge-upstream requires the default branch, ${context.defaultBranch}.`,
    );
  }

  if (pr.headRefName === '') {
    return refuse('no-head-branch', `Head branch unavailable for #${pr.number}.`);
  }

  if (liveSessions > 0) {
    return refuse('session-running', 'This card has an active session.');
  }

  return {
    ok: true,
    plan: {
      action,
      evidence: actionEvidence(context),
      repository: context.repository,
      issueNumber: context.issueNumber,
      pullRequest: pr.number,
      branch: pr.headRefName,
      base: pr.baseRefName,
    },
  };
}

/** Whether the action is enabled with a nonempty prompt. */
export function actionEnabled(action: AutomatableAction, settings: ActionSettings): boolean {
  const setting = settings.actions[action];

  return setting !== undefined && setting.enabled && setting.prompt.trim().length > 0;
}

/** Return the configured prompt, or null when empty. Repository workflow has no shipped prompt default. */
export function promptFor(action: AutomatableAction, settings: ActionSettings): string | null {
  const prompt = settings.actions[action]?.prompt.trim() ?? '';

  return prompt.length > 0 ? prompt : null;
}
