import type { MachineDeps, ReadText } from './machine.js';
import type { ReadFailure, Session, SessionActivity } from './types.js';

/**
 * Sessions and a failure are not exclusive: a CLI listing ten sessions and one entry the board cannot read reports
 * both, so one malformed entry costs one card instead of every card (R2).
 */
export interface AgentReading {
  sessions: Session[];
  failure: ReadFailure | null;
}

export type ActivityPlan =
  | { kind: 'up-to-date' }
  | { kind: 'write'; text: string; added: number; removed: number }
  | { kind: 'refuse'; reason: string; remedy: string };

export interface ActivityPlanInput {
  /** The agent's own settings file as text, or null when it does not exist. */
  settingsText: string | null;
  home: string;
  wanted: 'install' | 'remove';
}

/** One marker file appearing, being rewritten, or being removed. The watcher reports a batch of these. */
export interface ActivityChange {
  kind: 'created' | 'changed' | 'deleted';
  sessionId: string;
}

/**
 * The phase signal an agent offers, where it offers one. Claude's is a hook script writing a marker per session;
 * another CLI may offer a status file, a socket, or nothing, and an adapter with none produces sessions with no phase.
 */
export interface ActivitySignal {
  /** What to write to put the signal in place, or take it away. Pure: the caller does the file system. */
  plan(input: ActivityPlanInput): ActivityPlan;
  /** The agent's own settings file, which `plan` rewrites and the caller backs up first. */
  settingsPath(home: string): string;
  /** The directory whose changes mean a phase may have moved. Created on install and removed on uninstall. */
  watchDir(home: string): string;
  /** The last phase reported for a session, or null to claim nothing. */
  read(home: string, sessionId: string, readText: ReadText, now?: number): SessionActivity | null;
  /**
   * A file the agent has to be able to spawn, and its exact contents. Written when the bytes differ and left behind
   * on removal: a session that already read the old settings goes on spawning it, and a deleted script makes each of
   * them report a failure on every event. Absent where the signal needs no file of its own.
   */
  readonly writer?: { path(home: string): string; source: string };
}

/**
 * One agent CLI the board reads live sessions from. An adapter owns its transport, its response shape, where its
 * transcripts live, and the wording of its failures, and returns finished `Session` rows.
 */
export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly defaultPath: string;
  /** R30: a CLI that is not the developer's primary agent stays off until they enable it, so absence never nags. */
  readonly defaultEnabled: boolean;
  /** Lists every live session this CLI reports. Never throws — a failure comes back classified. */
  listSessions(path: string, deps: MachineDeps): Promise<AgentReading>;
  readonly activity?: ActivitySignal;
}
