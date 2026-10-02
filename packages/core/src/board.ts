import { z } from 'zod';
import type { CardAction, DispatchedAction, WorktreeCreation } from './actions.js';
import type { CardCheckout } from './checkout.js';
import type { IssueCard } from './cards.js';
import type { CardTriage } from './triage.js';
import type { CardWorktree } from './worktrees.js';
import type { HistoricalSession, Session } from './types.js';

export type LaneId = 'unstarted' | 'plan' | 'build' | 'review' | 'icebox' | 'archived';

/** Left to right on the board. `archived` is last and renders only behind the toggle. */
export const LANE_ORDER: readonly LaneId[] = ['unstarted', 'plan', 'build', 'review', 'icebox', 'archived'];

export const LANE_TITLES: Readonly<Record<LaneId, string>> = {
  unstarted: 'Unstarted',
  plan: 'Plan',
  build: 'Build',
  review: 'Review',
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

/** A workflow stage a developer's skill reports for its card (R49); each names the lane it places the card in. */
export const WORKFLOW_STAGES = ['plan', 'build', 'review'] as const;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

/** How far through its stage a report says the work is: step `n` of `of`. */
export interface StageStep {
  n: number;
  of: number;
}

/** Longest step count a report may give. */
export const STAGE_STEP_LIMIT = 50;

/** One earlier report on a card, kept so the card can show where the time went (R49). */
export interface StageEntry {
  stage: WorkflowStage;
  note: string;
  step?: StageStep;
  /** Epoch milliseconds of the report that set it; it lasted until the next entry, or the current report's `changedAt`. */
  at: number;
}

/** The stage last reported for a card, with its progress note, step, and the reports before it (R49). */
export interface CardStage {
  stage: WorkflowStage;
  /** One line of progress; empty where the report gave none. */
  note: string;
  step?: StageStep;
  /** Epoch milliseconds of the latest report; a repeated report refreshes it. */
  at: number;
  /** Epoch milliseconds of the report that set this note and step; a repeated report leaves it. */
  changedAt: number;
  /** Epoch milliseconds the card entered this stage. */
  since: number;
  /** Earlier distinct reports of this workflow, oldest first, at most `STAGE_HISTORY_LIMIT`. */
  history: StageEntry[];
}

/** Reports a card keeps behind its current one. */
export const STAGE_HISTORY_LIMIT = 20;

/** What `POST /stage` accepts: `done` releases the card to status and pull request evidence (R49). */
export interface StageRequest {
  issue: number;
  stage: WorkflowStage | 'done';
  /** Replaces the card's note; empty clears it. */
  note: string;
  /** Replaces the card's step; absent clears it. */
  step?: StageStep;
}

/** The hub's answer to a stage report. `pending` means no card has that issue yet; the stage applies once one does. */
export type StageAnswer =
  | { ok: true; lane: LaneId | null; note: string; pending: boolean }
  | { ok: false; reason: string };

export const stageStepSchema = z.object({ n: z.number().int().min(1), of: z.number().int().min(1).max(STAGE_STEP_LIMIT) })
  .refine((step) => step.n <= step.of);

const stageRequest = z.object({
  issue: z.number().int().positive(),
  stage: z.enum([...WORKFLOW_STAGES, 'done']),
  note: z.string().default(''),
  step: stageStepSchema.optional(),
});

/** Validate a stage report from outside the hub; null where it is not one. */
export function readStageRequest(body: unknown): StageRequest | null {
  const parsed = stageRequest.safeParse(body);

  if (!parsed.success) return null;

  const { step, ...rest } = parsed.data;

  return step === undefined ? rest : { ...rest, step };
}

/** Card border state, in priority order: failed, blocked, your-turn, running (R6). */
export type Attention = 'failed' | 'blocked' | 'your-turn' | 'running';

export interface LanedCard extends BoardCard {
  lane: LaneId;
  returned: boolean;
  /** Attention or running state; null when neither applies. */
  attention: Attention | null;
  /** Present when the attention is retained from a session that has ended; the border dims to match its hollow mark (R6). */
  retainedAttention?: true;
  /** Membership explanation, independent of lane placement. */
  reason: string;
  /** The workflow stage placing the card, while it holds (R49). */
  stage?: CardStage;
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

/** The queue view's sections, top to bottom, before Done (R53). */
export const QUEUE_SECTIONS = ['waiting', 'working', 'unstarted', 'icebox'] as const;

export type QueueSectionId = (typeof QUEUE_SECTIONS)[number];

/**
 * One card in a queue section: when it entered the section, or its queue time in Unstarted and Icebox, and, in Waiting
 * for you, whether work still runs on it.
 */
export interface QueuedCard {
  key: string;
  since: number | null;
  running: boolean;
}

/** One section's cards in display order. */
export interface QueueSection {
  id: QueueSectionId;
  cards: QueuedCard[];
}

/** A card's ended time on the board, from arrival to departure (R53). */
export interface DoneVisit {
  /** The card key and visit start, which together name one visit. */
  id: string;
  issueNumber: number;
  title: string;
  url: string;
  repository: string | null;
  startedAt: number;
  endedAt: number;
  /** The card never entered Waiting for you during the visit; it stays in Done until acknowledged. */
  unattended: boolean;
  /** The runs the visit started, oldest first. */
  actions: DispatchedAction[];
  /** How the card left: its last status, closed, or unassigned. */
  left: string;
}

/** What the queue view draws (R53): the sections, then the ended visits newest first. */
export interface QueueView {
  sections: QueueSection[];
  done: DoneVisit[];
}
