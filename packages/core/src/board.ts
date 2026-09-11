import type { CardAction, WorktreeCreation } from './actions.js';
import type { CardCheckout } from './checkout.js';
import type { IssueCard } from './cards.js';
import type { CardTriage } from './triage.js';
import type { CardWorktree } from './worktrees.js';
import type { HistoricalSession, Session } from './types.js';

export type LaneId = 'unstarted' | 'plan' | 'build' | 'review' | 'done' | 'icebox' | 'archived';

/** Left to right on the board. `archived` is last and renders only behind the toggle. */
export const LANE_ORDER: readonly LaneId[] = ['unstarted', 'plan', 'build', 'review', 'done', 'icebox', 'archived'];

export const LANE_TITLES: Readonly<Record<LaneId, string>> = {
  unstarted: 'Unstarted',
  plan: 'Plan',
  build: 'Build',
  review: 'Review',
  done: 'Done',
  icebox: 'Icebox',
  archived: 'Archived',
};

/**
 * Issue and associated sessions (R3), or ad-hoc sessions (R4). Unresolved issues have both issue and issueNumber
 * set to null.
 */
export interface BoardCard {
  key: string;
  issue: IssueCard | null;
  issueNumber: number | null;
  sessions: Session[];
  /** Present only on an issue card with no live sessions. Older snapshots omit it. */
  lastSession?: HistoricalSession;
  /** True for looked-up unassigned issues; absent for assigned issues. */
  unassigned?: true;
}

/** Card border state, in priority order: failed, blocked, your-turn, running (R6). */
export type Attention = 'failed' | 'blocked' | 'your-turn' | 'running';

export interface LanedCard extends BoardCard {
  lane: LaneId;
  returned: boolean;
  /** Attention or running state; null when neither applies. */
  attention: Attention | null;
  /** Membership explanation, independent of lane placement. */
  reason: string;
  /** Triage result or progress; absent before classification. */
  triage?: CardTriage;
  /** Available, refused, running, or completed card action; absent for unsupported actions. */
  action?: CardAction;
  /** Resolved checkout, when available. */
  checkout?: CardCheckout;
  /** The worktree for this card's issue, independent of which checkout was resolved (R46). */
  worktree?: CardWorktree;
  /** The offer to make a worktree, or the run making one; absent where the card has one or is read-only (R46). */
  creation?: WorktreeCreation;
}

export interface Lane {
  id: LaneId;
  title: string;
  cards: LanedCard[];
}
