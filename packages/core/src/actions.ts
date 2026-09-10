import type { TriageAction } from './triage.js';

/**
 * Supported unattended card action: merge the requested base branch into the PR head (R39). General conflict
 * resolution is not a separate action.
 */
export const AUTOMATABLE_ACTIONS = ['merge-upstream'] as const;

export type AutomatableAction = (typeof AUTOMATABLE_ACTIONS)[number];

export function isAutomatable(action: TriageAction): action is AutomatableAction {
  return (AUTOMATABLE_ACTIONS as readonly string[]).includes(action);
}

/** Action enablement and prompt. Missing settings or an empty prompt disable automatic runs (R32). */
export interface ActionSetting {
  enabled: boolean;
  /**
   * Prompt placeholders are filled from fresh card context: {issue}, {repo}, {pr}, {branch}, {base},
   * {checkout}, and {resultPath}. Claude supports leading slash commands (mechanics M33); Codex receives plain
   * prompt text.
   */
  prompt: string;
}

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
   * Rolling 24-hour dispatch-attempt limit, including failures. Zero disables automatic starts while
   * permitting manual requests. Pending dispatches are not reserved against this limit.
   */
  dailyLimit: number;
  /**
   * Whether the GitHub overlay may start a card action. Off by default: a limit the developer set for their
   * own requests is not consent for a web page to spend it (R32).
   */
  fromBrowser: boolean;
  /** Timeout for a dispatched session to appear on the roster. */
  resultTimeoutMs: number;
  actions: Partial<Record<AutomatableAction, ActionSetting>>;
}

/**
 * Persisted dispatch attempt and authorization evidence. Failed attempts may retry; landed outcomes block
 * automatic repeats even after a head change. An unreadable dispatch ID can produce failed after process
 * creation.
 */
export interface ActionRun {
  key: string;
  action: AutomatableAction;
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
  kind: string;
  message: string;
  at: number;
  /** Refusal rule revision; discard older revisions. */
  revision: number;
}

/**
 * Session-written result used to settle an action; not independent verification.
 */
export interface ActionReport {
  outcome: 'pushed' | 'halted';
  detail: string;
  /** Optional report path for display. */
  auditPath?: string | undefined;
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
  /** Dispatch timestamps in the rolling day, oldest first, for daily-limit checks. */
  dispatches: number[];
}

export const EMPTY_ACTIONS: ActionState = { runs: {}, refusals: {}, gates: {}, dispatches: [] };

/**
 * Increment when action rules change enough to invalidate prior refusals and automatic-repeat checks.
 */
export const ACTION_REVISION = 2;

/**
 * Editor action state. available permits a manual request regardless of automatic enablement; refused supplies
 * the failed check. Running and completed results take precedence.
 */
export type CardAction =
  | { state: 'available'; action: AutomatableAction }
  | { state: 'refused'; action: AutomatableAction; reason: string }
  | { state: 'running'; action: AutomatableAction; since: number }
  | { state: 'done'; action: AutomatableAction; outcome: ActionOutcome; detail: string; at: number };
