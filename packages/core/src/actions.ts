import type { TriageAction } from './triage.js';

/**
 * The one triage action the board is willing to perform rather than merely label (`prd.md` R39): merging the base
 * branch into the head, where somebody asked for it. A branch that will not merge is not on this list — resolving
 * conflicts is not the developer's job on this team, so the board has nothing to offer there.
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
   * What the dispatched session is told to do, with `{issue}`, `{repo}`, `{pr}`, `{branch}`, `{base}`, `{checkout}`
   * and `{resultPath}` filled from the board's own read. A leading `/` reaches the CLI as a slash command
   * (`docs/mechanics.md` §33), which is what lets a developer name the skill their repository already carries.
   */
  prompt: string;
}

/**
 * What the board may do on its own. Every field bounds a spend or a blast radius, so a hand-edited one is floored
 * rather than taken, the way `TriageSettings` is.
 */
export interface ActionSettings {
  /**
   * What a dispatched session may do without asking. `auto` is the shipped value: it is the narrowest mode a `--bg`
   * run finishes under, since `manual` and `acceptEdits` park on the first `git` command and `dontAsk` denies it
   * (`docs/mechanics.md` §33). Loosening past it to `bypassPermissions` is the developer's own (R31).
   */
  permissionMode: string;
  /**
   * How many dispatched sessions may be working at once — counted from the runs the board is following, not from
   * how many are being started, because `--bg` returns long before the work finishes. These are real builds in real
   * checkouts, so the shipped value is one.
   */
  concurrency: number;
  /**
   * How many the board may start in a rolling day, whatever else changes. A runaway costs money and pushes code, so
   * this is the ceiling on a mistake. Zero stops the board acting on its own and leaves each card's control working.
   */
  dailyLimit: number;
  /** How long a dispatch whose session never appeared is left open before the board calls it lost. */
  resultTimeoutMs: number;
  actions: Partial<Record<AutomatableAction, ActionSetting>>;
}

/**
 * One run the board started, as it is stored. `evidence` is what the card looked like when the run was authorised;
 * a card whose evidence has not moved is never dispatched again, which is what keeps a merge that halted from being
 * started over on every pass. A run that `failed` is the exception — no session started, so nothing was spent.
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
  /** The session the CLI minted, resolved from the roster by the short id it printed (`mechanics.md` §33). */
  sessionId: string | null;
  /** What the CLI printed as the session's short id, which is what the full one is resolved by, and what stops it. */
  shortId: string;
  outcome: ActionOutcome;
  /** One sentence. What the run reported about itself, or what the board settled it as. */
  detail: string;
}

/**
 * How a run ended. Every one of these is what the run said about itself or what stopped it — `landed` included,
 * since only the session knows whether it finished the job (R23). The board decides none of them from GitHub.
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

/** What a dispatched session says it did, at the path the prompt was given. This is the verdict — nothing else measures the run. */
export interface ActionReport {
  outcome: 'pushed' | 'halted';
  detail: string;
  /** Where the run left a fuller account, for the developer to open. Display only. */
  auditPath?: string | undefined;
}

/**
 * What the board remembers about its own runs across restarts. Keyed by card key, as lanes and triage are.
 *
 * `gates` is what keeps the board from asking GitHub about the same card on every pass. Deciding whether a card may
 * be acted on needs a fresh read — the stored reading is up to twelve hours old and this authorises a push — so a
 * card the board has just answered for is not asked about again until its gate lifts. Without it a board of fifteen
 * cards would query GitHub fifteen times a loop for cards it has already refused.
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
 * What the board is willing to act on. Bumped whenever a gate changes what a run against the same evidence would
 * do: a run stored under an older revision stops blocking a fresh dispatch, which is what lets a corrected gate
 * reach cards a broken one already spent.
 */
export const ACTION_REVISION = 2;

/**
 * What a client draws about a card's action, where the board has one. `available` is a card the board could act on
 * and the developer may press, whether or not the setting is on: it is what keeps the setting from being the only
 * way to run one. `refused` carries the reason, and is what a card shows rather than a control that could only
 * refuse — a stacked base branch, no checkout, an agent already on the card, or no prompt configured.
 */
export type CardAction =
  | { state: 'available'; action: AutomatableAction }
  | { state: 'refused'; action: AutomatableAction; reason: string }
  | { state: 'running'; action: AutomatableAction; since: number }
  | { state: 'done'; action: AutomatableAction; outcome: ActionOutcome; detail: string; at: number };
