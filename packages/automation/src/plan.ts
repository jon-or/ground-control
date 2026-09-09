import type {
  ActionSettings,
  AutomatableAction,
  CardCheckout,
  LaneId,
  TriageContext,
} from '@ground-control/core';
import { actionEvidence } from './evidence.js';

/** Why the board will not act on a card. Each has its own remedy, so each is named rather than folded (R25). */
export interface ActionRefusal {
  kind: string;
  message: string;
}

/** Everything a dispatch needs, once every gate has passed. Nothing here is guessed; each field was read. */
export interface ActionPlan {
  action: AutomatableAction;
  evidence: string;
  repository: string;
  issueNumber: number;
  pullRequest: number;
  /** The branch the work is on — what the merge goes into. */
  branch: string;
  /** The branch it merges from, which every gate below has proved is the repository's own default. */
  base: string;
  checkout: string;
}

export type ActionDecision = { ok: true; plan: ActionPlan } | { ok: false; refusal: ActionRefusal };

/**
 * Lanes the board never acts in. Done and Icebox are the developer saying the card is not theirs to push on (R7),
 * and Archived is work that has left their hands (R9). A merge started in one of those is the board overruling a
 * placement, which is the one thing R8 keeps for the developer alone.
 */
const PARKED_LANES: readonly LaneId[] = ['done', 'icebox', 'archived'];

function refuse(kind: string, message: string): ActionDecision {
  return { ok: false, refusal: { kind, message } };
}

function mine(login: string | null, logins: readonly string[]): boolean {
  return login !== null && logins.some((own) => own.toLowerCase() === login.toLowerCase());
}

export interface PlanInput {
  /**
   * What the card was read to need. The board derives no merge of its own — a branch going stale is not an
   * instruction to touch it (R39) — so this is a request somebody wrote, or the developer's own press.
   */
  action: AutomatableAction;
  context: TriageContext;
  lane: LaneId;
  /** Refuse unattended actions while any session is already on the card (R39). */
  liveSessions: number;
  checkout: CardCheckout | null;
  settings: ActionSettings;
}

/**
 * Whether the board may act on this card, decided entirely on the fresh read. Every refusal names itself, and the
 * order is what makes the message useful: the most specific thing wrong is the one the developer is told about.
 */
export function planAction(input: PlanInput): ActionDecision {
  const { action, context, lane, liveSessions, checkout } = input;
  const pr = context.pullRequest;

  if (PARKED_LANES.includes(lane)) {
    return refuse('lane-parked', `This card is in ${lane}, so the board leaves it alone.`);
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

  if (!mine(pr.author, context.logins)) {
    return refuse('pull-request-not-yours', `Pull request #${pr.number} is not yours to merge.`);
  }

  if (context.defaultBranch === null) {
    return refuse('no-default-branch', 'The board could not read which branch this repository merges into.');
  }

  // The whole of the multi-leg case. A branch based on another feature branch needs its parent current before this
  // merge means anything, and the board has no way to establish that order — so it labels the card and stops.
  if (pr.baseRefName !== context.defaultBranch) {
    return refuse(
      'stacked-branch',
      `#${pr.number} merges into ${pr.baseRefName}, not ${context.defaultBranch}, so keeping it current is a chain.`,
    );
  }

  if (pr.headRefName === '') {
    return refuse('no-head-branch', `The board could not read which branch #${pr.number} is on.`);
  }

  if (liveSessions > 0) {
    return refuse('session-running', 'Something is already working on this card.');
  }

  // A checkout an agent has run in, never one the developer merely picked and never a branch name (R37, R39): the
  // caller narrows it, because a folder pointed at is enough to open a window and not enough to edit code unwatched.
  if (checkout === null) {
    return refuse('no-checkout', 'The board has no checkout an agent has worked in for this card.');
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
      checkout: checkout.root,
    },
  };
}

/** Whether the developer has turned this action on and given it something to run. */
export function actionEnabled(action: AutomatableAction, settings: ActionSettings): boolean {
  const setting = settings.actions[action];

  return setting !== undefined && setting.enabled && setting.prompt.trim().length > 0;
}

/**
 * The prompt for one action, or null where it has none. An action turned on with nothing to say is off: there is no
 * shipped default, because what runs a merge is the developer's own repository's skill and no two teams share one.
 */
export function promptFor(action: AutomatableAction, settings: ActionSettings): string | null {
  const prompt = settings.actions[action]?.prompt.trim() ?? '';

  return prompt.length > 0 ? prompt : null;
}
