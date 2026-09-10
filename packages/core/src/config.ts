import { existsSync } from 'node:fs';
import { z } from 'zod';
import { AUTOMATABLE_ACTIONS } from './actions.js';
import { LANE_ORDER } from './board.js';
import type { ActionSettings } from './actions.js';
import type { LaneId } from './board.js';
import { LOG_FLOORS } from './log.js';
import { DEFAULT_SESSION_SCOPE, sessionScopeSchema } from './sessionScope.js';
import { DEFAULT_AVATAR_POLICY, OFF_REVIEW_AVATARS, REVIEW_AVATARS } from './source.js';
import type { AvatarPolicy } from './source.js';
import { agentHomeSchema } from './agentHomes.js';
import type { SessionScope } from './sessionScope.js';
import type { AgentConfig, ReadFailure } from './types.js';
import type { LogFloor } from './log.js';

/** Shared hub configuration, merged over defaults. Host and source adapters validate their own entries. */
export interface HubConfig {
  agents: AgentConfig[];
  /** Accepted absolute agent roots, persisted independently of the next hub launcher's environment. */
  agentHomes?: Record<string, string> | undefined;
  /** Matches an issue number in a branch or directory name. The team's convention, so it ships as a default. */
  branchIssuePattern: string;
  hosts: Record<string, unknown>;
  sources: Record<string, unknown>;
  boardStatuses: string[];
  statusLanes: Record<string, LaneId>;
  refreshIntervalMs: number;
  sessionIntervalMs: number;
  /** How long the hub stays up after its last client disconnects. */
  idleExitMs: number;
  logs: LogSettings;
  /** Whose face a card shows (R5). */
  avatar: AvatarPolicy;
  sessionScope?: SessionScope;
  installActivity: boolean;
  /** Per-agent hook choices; omission permits hooks while installActivity remains authoritative. */
  sessionHooks?: Record<string, boolean>;
  /** Log detail level; info diagnostics remain enabled (LOG_FLOORS). */
  logLevel: LogFloor;
  triage: TriageSettings;
  actions: ActionSettings;
  newSession: NewSessionSettings;
}

/** Hub log rotation and dispatch-output retention. Markers and settings backups are safety state with fixed limits. */
export interface LogSettings {
  /** Rotate hub.log at this size. */
  rotateBytes: number;
  /** Rotated files kept beside hub.log; 0 truncates instead of rotating. */
  kept: number;
  /** Age after which <agent>-dispatch-<id>.log files are deleted. */
  dispatchRetentionMs: number;
}

/**
 * Optional unsent prompt for a developer-started session (R42). Empty opens a bare session; it does not disable
 * starting. This differs from an automatic action, which requires a nonempty prompt (R39).
 */
export interface NewSessionSettings {
  prompt: string;
}

/** Triage enablement, concurrency, timeout, and display names. */
export interface TriageSettings {
  enabled: boolean;
  /** Empty uses the classifier default; absent preserves a legacy AgentConfig model. */
  model?: string | undefined;
  /** Explicit mode overrides legacy enabled. Missing mode preserves legacy configuration. */
  mode?: 'off' | 'manual' | 'automatic';
  /** Automatic attempts per rolling 24 hours, including failures and cancellations. */
  dailyLimit?: number;
  /** How many cards are read and classified at once. Fetch and classification share the budget. */
  concurrency: number;
  /** Combined source-read and classification timeout. */
  timeoutMs: number;
  /** Display-name overrides by login. */
  names: Record<string, string>;
}

/** Configured command name or path, validated before process launch. */
export const spawnable = z
  .string()
  .min(1)
  .refine((path) => !/[\\/]/.test(path) || existsSync(path), {
    message: 'must be a command name on PATH or a file that exists',
  });

/** Read configured adapter IDs, filtering non-string entries. Use defaults when the outer value is not an array. */
export function idsFrom(raw: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && id.trim().length > 0) : [...fallback];
}

const laneId = z.enum(LANE_ORDER as [LaneId, ...LaneId[]]);

/** Minimum polling intervals prevent repeated immediate reads. */
const REFRESH_FLOOR_MS = 30_000;
const SESSION_FLOOR_MS = 2_000;

export const DEFAULT_LOGS: LogSettings = { rotateBytes: 1_000_000, kept: 2, dispatchRetentionMs: 7 * 24 * 60 * 60 * 1000 };

/** Clamp a number setting; anything that is not a finite number keeps the default. */
function bounded(fallback: number, floor: number, ceiling: number) {
  return z
    .number()
    .finite()
    .catch(fallback)
    .default(fallback)
    .transform((value) => Math.min(ceiling, Math.max(floor, value)));
}

// Sizes under 100 KB would rotate constantly; retention under a day would delete output of a run still in progress.
const logs = z
  .object({
    rotateBytes: bounded(DEFAULT_LOGS.rotateBytes, 100_000, 100_000_000),
    kept: bounded(DEFAULT_LOGS.kept, 0, 20).transform((kept) => Math.round(kept)),
    dispatchRetentionMs: bounded(DEFAULT_LOGS.dispatchRetentionMs, 24 * 60 * 60 * 1000, 365 * 24 * 60 * 60 * 1000),
  })
  .catch(() => ({ ...DEFAULT_LOGS }))
  .default(() => ({ ...DEFAULT_LOGS }));

/** No-client exit window: default 30 minutes, clamped to one minute and one day. */
export const DEFAULT_IDLE_EXIT_MS = 30 * 60 * 1000;
export const IDLE_EXIT_FLOOR_MS = 60 * 1000;
export const IDLE_EXIT_CEILING_MS = 24 * 60 * 60 * 1000;

/** Bound automatic triage usage with timeout and concurrency limits. */
const TRIAGE_TIMEOUT_FLOOR_MS = 10_000;
const TRIAGE_TIMEOUT_CEILING_MS = 300_000;
const TRIAGE_CONCURRENCY_CEILING = 8;

export const DEFAULT_TRIAGE: TriageSettings = { enabled: true, mode: 'manual', dailyLimit: 100, concurrency: 2, timeoutMs: 180_000, names: {} };

export function triageMode(settings: TriageSettings): 'off' | 'manual' | 'automatic' {
  return settings.mode ?? (settings.enabled ? 'automatic' : 'off');
}

const triage = z.object({
  enabled: z.boolean(),
  model: z.string().trim().optional(),
  mode: z.enum(['off', 'manual', 'automatic']).optional(),
  dailyLimit: z.number().int().min(0).max(1000).default(100),
  concurrency: z.number().finite().transform((n) => Math.min(TRIAGE_CONCURRENCY_CEILING, Math.max(1, Math.trunc(n)))),
  timeoutMs: z
    .number()
    .finite()
    .transform((ms) => Math.min(TRIAGE_TIMEOUT_CEILING_MS, Math.max(TRIAGE_TIMEOUT_FLOOR_MS, ms))),
  // Invalid or missing display-name overrides default to an empty map.
  names: z.record(z.string(), z.string()).catch({}).default({}),
}).transform((settings) => {
  const mode = settings.mode ?? (settings.enabled ? 'automatic' : 'off');
  return { ...settings, mode, enabled: mode !== 'off' };
});

/**
 * Unattended action settings, disabled by default. Bound concurrency, daily attempts, and session appearance time
 * (R32).
 */
const ACTION_CONCURRENCY_CEILING = 4;
const ACTION_DAILY_CEILING = 50;
const ACTION_RESULT_TIMEOUT_FLOOR_MS = 60_000;
const ACTION_RESULT_TIMEOUT_CEILING_MS = 4 * 60 * 60 * 1000;

/**
 * Resolve the configured command or fall back to the agent ID on PATH, matching adapter command resolution.
 */
export function agentCommand(configured: Record<string, string>, id: string): string {
  return configured[id]?.trim() || id;
}

/** Shared mode names. Reject unknown values; adapters declare the modes they support (M33, M46). */
export const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'dontAsk', 'plan', 'bypassPermissions'] as const;

export const DEFAULT_ACTIONS: ActionSettings = {
  permissionMode: 'auto',
  concurrency: 1,
  dailyLimit: 10,
  resultTimeoutMs: 30 * 60 * 1000,
  actions: {},
};

const actionSetting = z.object({
  enabled: z.boolean().catch(false).default(false),
  prompt: z.string().catch('').default(''),
});

const actions = z.object({
  agent: z.enum(['auto', 'claude', 'codex']).optional(),
  model: z.string().trim().optional(),
  permissionMode: z.enum(PERMISSION_MODES).default('auto'),
  concurrency: z
    .number()
    .finite()
    .transform((n) => Math.min(ACTION_CONCURRENCY_CEILING, Math.max(1, Math.trunc(n)))),
  dailyLimit: z
    .number()
    .finite()
    .transform((n) => Math.min(ACTION_DAILY_CEILING, Math.max(0, Math.trunc(n)))),
  resultTimeoutMs: z
    .number()
    .finite()
    .transform((ms) => Math.min(ACTION_RESULT_TIMEOUT_CEILING_MS, Math.max(ACTION_RESULT_TIMEOUT_FLOOR_MS, ms))),
  // Unsupported actions invalidate the action map without rejecting the rest of the configuration.
  actions: z
    .record(z.enum(AUTOMATABLE_ACTIONS), actionSetting)
    .catch({})
    .default({}),
});

export const DEFAULT_NEW_SESSION: NewSessionSettings = { prompt: '' };

// Preserve prompt text as entered; it does not start work automatically.
const newSession = z.object({ prompt: z.string().catch('').default('') });

export const hubConfig = z.object({
  agents: z.array(z.object({ id: z.string().min(1), path: spawnable, model: z.string().min(1).optional() })),
  branchIssuePattern: z.string(),
  hosts: z.record(z.string(), z.unknown()),
  sources: z.record(z.string(), z.unknown()),
  boardStatuses: z.array(z.string()),
  statusLanes: z.record(z.string(), laneId),
  refreshIntervalMs: z.number().finite().transform((ms) => Math.max(REFRESH_FLOOR_MS, ms)),
  sessionIntervalMs: z.number().finite().transform((ms) => Math.max(SESSION_FLOOR_MS, ms)),
  // A window under a minute would drop the hub between an editor reload and its reconnect.
  idleExitMs: bounded(DEFAULT_IDLE_EXIT_MS, IDLE_EXIT_FLOOR_MS, IDLE_EXIT_CEILING_MS),
  logs,
  // The outer catch also absorbs the single string an older client wrote here.
  avatar: z
    .object({
      review: z.enum(REVIEW_AVATARS).catch('pull-request-author').default('pull-request-author'),
      offReview: z.enum(OFF_REVIEW_AVATARS).catch('assignee').default('assignee'),
    })
    .catch({ ...DEFAULT_AVATAR_POLICY })
    .default({ ...DEFAULT_AVATAR_POLICY }),
  sessionScope: sessionScopeSchema.default(DEFAULT_SESSION_SCOPE),
  agentHomes: z.record(z.string(), agentHomeSchema).optional(),
  installActivity: z.boolean(),
  sessionHooks: z.record(z.string(), z.boolean()).default({}),
  // Default missing or unsupported log levels to info for cross-version compatibility.
  logLevel: z.enum(LOG_FLOORS).catch('info').default('info'),
  // Absent from a configuration written by a client that predates triage.
  triage: triage.default(DEFAULT_TRIAGE),
  // Older configurations default to no unattended actions (R32).
  actions: actions.default({ ...DEFAULT_ACTIONS, permissionMode: 'auto' }),
  newSession: newSession.default(DEFAULT_NEW_SESSION),
});

/** Parse client configuration or return a classified failure for display (R25). */
export function parseHubConfig(raw: unknown): { config: HubConfig } | { failure: ReadFailure } {
  const parsed = hubConfig.safeParse(raw);

  if (parsed.success) {
    return { config: parsed.data };
  }

  const first = parsed.error.issues[0];

  return {
    failure: {
      subject: 'config',
      kind: 'bad-config',
      message: `Could not read settings: ${first?.path.join('.') ?? 'configuration'} ${first?.message ?? 'is not valid'}.`,
      remedy: 'Correct the setting or remove it to use the default.',
    },
  };
}
