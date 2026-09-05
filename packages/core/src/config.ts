import { existsSync } from 'node:fs';
import { z } from 'zod';
import { LANE_ORDER } from './board.js';
import type { LaneId } from './board.js';
import type { AgentConfig, ReadFailure } from './types.js';

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
  triage: TriageSettings;
}

/** What card triage is allowed to cost. Every field bounds a spend, so a hand-edited one is floored rather than taken. */
export interface TriageSettings {
  enabled: boolean;
  /** How many cards are read and classified at once. Fetch and classification share the budget. */
  concurrency: number;
  /** The whole of one card's triage — the source read and the classification together, not the classification alone. */
  timeoutMs: number;
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

export const DEFAULT_TRIAGE: TriageSettings = { enabled: true, concurrency: 2, timeoutMs: 60_000 };

const triage = z.object({
  enabled: z.boolean(),
  concurrency: z.number().finite().transform((n) => Math.min(TRIAGE_CONCURRENCY_CEILING, Math.max(1, Math.trunc(n)))),
  timeoutMs: z
    .number()
    .finite()
    .transform((ms) => Math.min(TRIAGE_TIMEOUT_CEILING_MS, Math.max(TRIAGE_TIMEOUT_FLOOR_MS, ms))),
});

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
  // Absent from a configuration a client built before triage existed, which is every stored one written until now.
  triage: triage.default(DEFAULT_TRIAGE),
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
