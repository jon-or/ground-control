import { existsSync } from 'node:fs';
import { z } from 'zod';
import { AUTOMATABLE_ACTIONS } from './actions.js';
import { LANE_ORDER } from './board.js';
import type { ActionSettings } from './actions.js';
import type { LaneId } from './board.js';
import { LOG_FLOORS } from './log.js';
import type { AgentConfig, ReadFailure } from './types.js';
import type { LogFloor } from './log.js';

/**
 * Everything the hub polls with. A client pushes one of these and the hub merges it over its own defaults, so a hub
 * a browser started alone still reads sensibly. Host and source entries are opaque here and are parsed by the
 * adapter that owns the id — `core` may not know what a host wants.
 */
export interface HubConfig {
  agents: AgentConfig[];
  /** Matches an issue number in a branch or directory name. The team's convention, so it ships as a default. */
  branchIssuePattern: string;
  hosts: Record<string, unknown>;
  sources: Record<string, unknown>;
  boardStatuses: string[];
  statusLanes: Record<string, LaneId>;
  refreshIntervalMs: number;
  sessionIntervalMs: number;
  installActivity: boolean;
  /** How much detail the hub writes about itself. Never whether it writes at all — see `LOG_FLOORS`. */
  logLevel: LogFloor;
  triage: TriageSettings;
  actions: ActionSettings;
  newSession: NewSessionSettings;
}

/**
 * What a session the developer starts from a card is prefilled with. Ships empty, and empty means a bare session
 * rather than no session — unlike a card action, where an empty prompt means the action is off (R39). Nothing here
 * runs unattended: the prompt lands in the composer unsent, and the developer sends it or does not (R16).
 */
export interface NewSessionSettings {
  prompt: string;
}

/** What card triage is allowed to cost. Every field bounds a spend, so a hand-edited one is floored rather than taken. */
export interface TriageSettings {
  enabled: boolean;
  /** How many cards are read and classified at once. Fetch and classification share the budget. */
  concurrency: number;
  /** The whole of one card's triage — the source read and the classification together, not the classification alone. */
  timeoutMs: number;
  /**
   * Who a login really is, by login, where GitHub's own answer is not the person: an agent account whose profile
   * name is the agent's, or somebody whose profile carries no name at all. Overrides the profile name wherever the
   * board prints somebody.
   */
  names: Record<string, string>;
}

/**
 * A path the hub is willing to spawn: a bare command name, resolved against `PATH`, or a file that is there. Every
 * field of a pushed configuration that becomes a process is this, and a client is not necessarily this editor.
 */
export const spawnable = z
  .string()
  .min(1)
  .refine((path) => !/[\\/]/.test(path) || existsSync(path), {
    message: 'must be a command name on PATH or a file that exists',
  });

/**
 * The ids naming a registry's targets, out of whatever a settings file holds. A hand-edited one holds what was
 * typed: a bare string where a list belongs, or an entry that is not a name. Nothing here is a target, so nothing
 * here can be refused by name — an unreadable list is the shipped one, and a list is exactly what it names.
 */
export function idsFrom(raw: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && id.trim().length > 0) : [...fallback];
}

const laneId = z.enum(LANE_ORDER as [LaneId, ...LaneId[]]);

/** Floors, not defaults: a hand-edited settings file can ask for a zero-second poll, which is a spin. */
const REFRESH_FLOOR_MS = 30_000;
const SESSION_FLOOR_MS = 2_000;

/** Ceilings as well as floors here, because every one of these bounds what the board may spend without being asked. */
const TRIAGE_TIMEOUT_FLOOR_MS = 10_000;
const TRIAGE_TIMEOUT_CEILING_MS = 300_000;
const TRIAGE_CONCURRENCY_CEILING = 8;

export const DEFAULT_TRIAGE: TriageSettings = { enabled: true, concurrency: 2, timeoutMs: 180_000, names: {} };

const triage = z.object({
  enabled: z.boolean(),
  concurrency: z.number().finite().transform((n) => Math.min(TRIAGE_CONCURRENCY_CEILING, Math.max(1, Math.trunc(n)))),
  timeoutMs: z
    .number()
    .finite()
    .transform((ms) => Math.min(TRIAGE_TIMEOUT_CEILING_MS, Math.max(TRIAGE_TIMEOUT_FLOOR_MS, ms))),
  // Whose name the board uses, where GitHub's answer is not the person. Written by an older build without it, or by
  // hand as something other than a map of strings, it reads as none rather than costing the whole configuration.
  names: z.record(z.string(), z.string()).catch({}).default({}),
});

/**
 * What the board may do on its own, and it starts at nothing (R32). Every ceiling here bounds something a mistake
 * would spend repeatedly: sessions in flight, dispatches in a day, and how long one is waited on.
 */
const ACTION_CONCURRENCY_CEILING = 4;
const ACTION_DAILY_CEILING = 50;
const ACTION_RESULT_TIMEOUT_FLOOR_MS = 60_000;
const ACTION_RESULT_TIMEOUT_CEILING_MS = 4 * 60 * 60 * 1000;

/**
 * The permission modes a dispatched session may be given, as the CLI names them (`docs/mechanics.md` §33). A value
 * outside this list would be handed straight to a spawn, so it is refused rather than passed through.
 */
/**
 * The command that runs one agent's CLI, from the `agents` map a client holds. An id named with no path is the CLI on
 * the path under its own name, which is the same fallback an adapter makes of an empty configured path — a client
 * that resolved it differently would run a command the hub never would.
 */
export function agentCommand(configured: Record<string, string>, id: string): string {
  return configured[id]?.trim() || id;
}

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
  permissionMode: z.enum(PERMISSION_MODES).catch('auto').default('auto'),
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
  // An action the board does not automate is dropped rather than refused: a settings file written by a later build
  // naming one this build has never heard of must not cost the developer their whole configuration.
  actions: z
    .record(z.enum(AUTOMATABLE_ACTIONS), actionSetting)
    .catch({})
    .default({}),
});

export const DEFAULT_NEW_SESSION: NewSessionSettings = { prompt: '' };

// No floor and no ceiling: this one spends nothing and starts nothing, so a hand-edited value is taken as typed.
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
  installActivity: z.boolean(),
  // Absent from a configuration written by a client that predates the hub saying what it is doing, and caught
  // rather than refused the way `permissionMode` is: a level a later build names is not worth a dead board over.
  logLevel: z.enum(LOG_FLOORS).catch('info').default('info'),
  // Absent from a configuration written by a client that predates triage.
  triage: triage.default(DEFAULT_TRIAGE),
  // Absent from one that predates the board acting at all, which reads as the board doing nothing on its own (R32).
  actions: actions.default(DEFAULT_ACTIONS),
  newSession: newSession.default(DEFAULT_NEW_SESSION),
});

/** The configuration a client pushed, or a named failure the board shows above the lanes rather than a throw (R25). */
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
      message: `The board's settings could not be read: ${first?.path.join('.') ?? 'configuration'} ${first?.message ?? 'is not valid'}.`,
      remedy: 'Correct the setting, or remove it to fall back to the shipped default.',
    },
  };
}
