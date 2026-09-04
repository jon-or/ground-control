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

export const hubConfig = z.object({
  agents: z.array(z.object({ id: z.string().min(1), path: spawnable })),
  branchIssuePattern: z.string(),
  hosts: z.record(z.string(), z.unknown()),
  sources: z.record(z.string(), z.unknown()),
  boardStatuses: z.array(z.string()),
  statusLanes: z.record(z.string(), laneId),
  refreshIntervalMs: z.number().finite().transform((ms) => Math.max(REFRESH_FLOOR_MS, ms)),
  sessionIntervalMs: z.number().finite().transform((ms) => Math.max(SESSION_FLOOR_MS, ms)),
  installActivity: z.boolean(),
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
