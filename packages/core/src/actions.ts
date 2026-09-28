import { MERGE_TYPES } from './merge.js';
import type { TriageAction, TriageQualifier } from './triage.js';

/**
 * Triage actions an action table row can name: the ones with refusal rules (R39). Fixing checks and general
 * conflict resolution are not among them.
 */
export const AUTOMATABLE_ACTIONS = ['merge', 'review-others', 'address-review'] as const;

export type AutomatableAction = (typeof AUTOMATABLE_ACTIONS)[number];

export function isAutomatable(action: TriageAction): action is AutomatableAction {
  return (AUTOMATABLE_ACTIONS as readonly string[]).includes(action);
}

/** The qualifiers a row for each action may name. */
export const ROW_QUALIFIERS: Readonly<Record<AutomatableAction, readonly TriageQualifier[]>> = {
  merge: MERGE_TYPES,
  'review-others': ['initial', 'followup'],
  'address-review': ['initial', 'followup'],
};

/**
 * One line of the action table (R39). A null qualifier matches any reading of the action. Prompt placeholders are
 * filled from fresh card context: {issue}, {repo}, {pr}, {branch}, {base}, {default}, {target}, {checkout}, and
 * {resultPath}. Claude supports leading slash commands (mechanics M33); Codex receives plain prompt text.
 */
export interface ActionRow {
  action: AutomatableAction;
  qualifier: TriageQualifier | null;
  prompt: string;
  /** Start the row when triage names it, without a click (R32). */
  automatic: boolean;
}

/** The row for a reading: the one naming its qualifier, else the one naming none. */
export function rowFor(
  table: readonly ActionRow[],
  action: AutomatableAction,
  qualifier: TriageQualifier | null,
): ActionRow | undefined {
  return (
    table.find((row) => row.action === action && row.qualifier !== null && row.qualifier === qualifier) ??
    table.find((row) => row.action === action && row.qualifier === null)
  );
}

/** The run that makes a card's worktree (R46). Not a triage action: it is asked for, or prepended to one. */
export const CREATE_WORKTREE = 'create-worktree';

/** Anything the board dispatches as a session: a card action, or the worktree run that precedes one. */
export type DispatchedAction = AutomatableAction | typeof CREATE_WORKTREE;

/**
 * Dispatch permissions and limits. Configuration parsing supplies defaults and clamps numeric bounds.
 */
export interface ActionSettings {
  /** Auto selects the first enabled dispatcher in registry order. */
  agent?: 'auto' | 'claude' | 'codex' | undefined;
  /** Empty uses the CLI default; absent preserves a legacy AgentConfig model. */
  model?: string | undefined;
  /**
   * Explicit permission mode. Claude defaults to auto based on the background-dispatch probes (mechanics M33).
   * Codex refuses auto and requires a supported override (R31).
   */
  permissionMode: string;
  /**
   * Concurrent running jobs plus in-flight dispatches. Default: one.
   */
  concurrency: number;
  /**
   * Rolling 24-hour limit on automatic dispatch attempts, including failures; zero disables automatic starts.
   * Manual requests neither need nor spend it. Pending dispatches are not reserved against this limit.
   */
  dailyLimit: number;
  /**
   * Whether the GitHub overlay may start a card action. Off by default: the overlay's controls sit in github.com's
   * DOM, where a page script can click them (R32).
   */
  fromBrowser: boolean;
  /** Timeout for a dispatched session to appear on the roster. */
  resultTimeoutMs: number;
  /** The action table; the first row for an action and qualifier wins (R39). */
  table: ActionRow[];
  /** A merge whose destination matches this regular expression is a test merge (R39). */
  testBranchPattern: string;
}

/**
 * Persisted dispatch attempt and authorization evidence, one per card. Failed attempts may retry; a landed run
 * blocks automatic repeats of its row, even after a head change, until a newer reading names the row again. An
 * unreadable dispatch ID can produce failed after process creation.
 */
export interface ActionRun {
  key: string;
  action: DispatchedAction;
  /** The action a worktree run was prepended to, dispatched in the worktree once it is reported (R46). */
  next?: AutomatableAction | undefined;
  /** The reading's qualifier for `action`, or for `next` on a worktree run: with the action, it names the row. */
  qualifier: TriageQualifier | null;
  /** The card's issue, which the session this run becomes is linked to (R3). Absent in older records. */
  issueNumber?: number | undefined;
  /** Action-rule revision; older runs do not block a new dispatch. */
  revision: number;
  evidence: string;
  /** Epoch milliseconds the dispatch was made. */
  startedAt: number;
  /** Epoch milliseconds the board settled the outcome, or null while it is still open. */
  endedAt: number | null;
  agent: string;
  /** Session ID resolved from the dispatch ID against the roster (mechanics M33). */
  sessionId: string | null;
  /** Dispatch ID used for roster matching and stopping: short for Claude, full thread ID for Codex. */
  shortId: string;
  outcome: ActionOutcome;
  /** One-sentence reported outcome or runner failure explanation. */
  detail: string;
}

/**
 * Runner state and session-reported outcome. landed is not independently verified completion evidence (R39);
 * future R23 requires a separate stage-completion check.
 */
export type ActionOutcome = 'running' | 'landed' | 'halted' | 'failed' | 'stopped';

/** Persisted action refusal for display and retry scheduling. */
export interface ActionRefusalRecord {
  /** The row it refused; a reading naming another row does not show it. Null where no row was known yet. */
  action: AutomatableAction | null;
  qualifier: TriageQualifier | null;
  kind: string;
  message: string;
  at: number;
  /** Refusal rule revision; discard older revisions. */
  revision: number;
}

/**
 * Session-written result used to settle an action; not independent verification. `pushed` is the earlier word for
 * `done`. A worktree run reports `ready` and the absolute path of the worktree it made (R46).
 */
export interface ActionReport {
  outcome: 'done' | 'pushed' | 'halted' | 'ready';
  detail: string;
  /** Optional report path for display. */
  auditPath?: string | undefined;
  worktree?: string | undefined;
}

/**
 * Persist action runs, refusals, retry gates, and dispatch timestamps by card. gates bound fresh-context reads
 * for automatic decisions; cached triage cannot authorize edits.
 */
export interface ActionState {
  runs: Record<string, ActionRun>;
  refusals: Record<string, ActionRefusalRecord>;
  /** Epoch milliseconds before which the board does not read a card again for actions. */
  gates: Record<string, number>;
  /** Automatic dispatch timestamps in the rolling day, oldest first, for daily-limit checks. */
  dispatches: number[];
  /** The issue each dispatched session belongs to, by `agent:sessionId` (R3). Outlives the run record. */
  links: Record<string, SessionLink>;
}

export interface SessionLink {
  issueNumber: number;
  /** Epoch milliseconds the link was recorded. */
  at: number;
}

export const EMPTY_ACTIONS: ActionState = { runs: {}, refusals: {}, gates: {}, dispatches: [], links: {} };

/**
 * Increment when action rules change enough to invalidate prior refusals and automatic-repeat checks.
 */
export const ACTION_REVISION = 2;

/**
 * Editor action state. available permits a manual request regardless of automatic enablement; refused supplies
 * the failed check. Running and completed results take precedence.
 */
export type CardAction = { action: AutomatableAction; qualifier: TriageQualifier | null } & (
  | { state: 'available' }
  /** `retryable` marks a refusal recorded from an earlier attempt: a manual request reads the card afresh and may start. */
  | { state: 'refused'; reason: string; retryable?: true }
  /** `stage` is `worktree` while the run that precedes the action is still making the worktree (R46). */
  | { state: 'running'; since: number; stage?: 'worktree' }
  | { state: 'done'; outcome: ActionOutcome; detail: string; at: number }
);

/**
 * The worktree control's state on a card with no worktree (R46). Absent where the card has one, has no issue, or
 * is read-only. Running and done describe the worktree run itself, whether asked for alone or before an action.
 */
export type WorktreeCreation =
  | { state: 'available' }
  | { state: 'refused'; reason: string }
  | { state: 'running'; since: number }
  | { state: 'done'; outcome: ActionOutcome; detail: string; at: number };
