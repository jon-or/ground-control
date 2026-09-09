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

/** What one action is allowed to do. Absent from the settings, or with an empty prompt, it is off (R32). */
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
  /** How long a dispatch whose session never appeared is left open before the board calls it lost. */
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
  /** The `ACTION_REVISION` this ran under. A run recorded by an older one no longer blocks a fresh dispatch. */
  revision: number;
  evidence: string;
  /** Epoch milliseconds the dispatch was made. */
  startedAt: number;
  /** Epoch milliseconds the board settled the outcome, or null while it is still open. */
  endedAt: number | null;
  agent: string;
  /** The session the CLI minted, resolved from the roster by the short id it printed (`mechanics.md` M33). */
  sessionId: string | null;
  /** What the CLI printed as the session's short id, which is what the full one is resolved by, and what stops it. */
  shortId: string;
  outcome: ActionOutcome;
  /** One sentence. What the run reported about itself, or what the board settled it as. */
  detail: string;
}

/**
 * Runner state and session-reported outcome. landed is not independently verified completion evidence (R39);
 * future R23 requires a separate stage-completion check.
 */
export type ActionOutcome = 'running' | 'landed' | 'halted' | 'failed' | 'stopped';

/** Why the board did not act on a card, kept so the same answer is not re-derived on every pass. */
export interface ActionRefusalRecord {
  kind: string;
  message: string;
  at: number;
  /** The `ACTION_REVISION` that refused. A reason a retired gate wrote is dropped rather than shown for good. */
  revision: number;
}

/**
 * Session-written result used to settle an action; not independent verification.
 */
export interface ActionReport {
  outcome: 'pushed' | 'halted';
  detail: string;
  /** Where the run left a fuller account, for the developer to open. Display only. */
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
  /** Epoch milliseconds of each dispatch inside the rolling day, oldest first. What the daily limit is counted on. */
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
