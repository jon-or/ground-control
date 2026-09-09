import type { MachineDeps, MachineReaders, ReadText } from './machine.js';
import type { HistoricalSession, ReadFailure, Session, SessionActivity } from './types.js';

export interface HistoryReading {
  sessions: HistoricalSession[];
  failure: ReadFailure | null;
}

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
 * One bounded question put to an agent, answered as JSON and nothing else. The session it runs in must not become a
 * session the board shows — the adapter owns how, and Claude's flags are measured in `docs/mechanics.md` M31.
 */
export interface ClassifyInput {
  /** The CLI, from the same configuration the roster read spawns. */
  path: string;
  /** Minted by the caller, so it can recognise its own run without waiting to be told what it started. */
  sessionId: string;
  model: string | null;
  systemPrompt: string;
  prompt: string;
  schema: unknown;
  /** A directory with no project of its own, so nothing of the developer's is discovered or loaded. */
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
}

/** Never throws: a classification that failed is a named failure, the same as a roster read that did (R24). */
export type ClassifyResult = { value: unknown } | { failure: ReadFailure };

/**
 * One piece of work handed to an agent to carry out, in the developer's own checkout. Unlike a classification this
 * is meant to be seen: it writes a transcript, loads the developer's settings, and becomes a session on the card
 * (R2). The caller cannot name the session — `--bg` mints its own id (`docs/mechanics.md` M33).
 */
export interface DispatchInput {
  /** The CLI, from the same configuration the roster read spawns. */
  path: string;
  /** Work prompt. Claude interprets a leading slash as a command (mechanics M33); other adapters may differ. */
  prompt: string;
  /** Requested display name. Adapter support varies; Claude uses it and Codex currently ignores it. */
  name: string;
  /** The checkout the work happens in, read from a session the card already carries and never from a branch name. */
  cwd: string;
  /** What the session may do without asking. Passed explicitly, because a bare `--bg` runs under `auto` (M33). */
  permissionMode: string;
  model: string | null;
  timeoutMs: number;
  signal: AbortSignal;
}

/**
 * Dispatch identity or failure. Claude returns a short ID, Codex a full thread ID. The runner matches the value
 * against a subsequent roster by prefix. A failure can follow process creation when identity cannot be read.
 */
export type DispatchResult = { shortId: string } | { failure: ReadFailure };

/**
 * One agent CLI the board reads live sessions from. An adapter owns its transport, its response shape, where its
 * transcripts live, and the wording of its failures, and returns finished `Session` rows.
 */
export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly defaultPath: string;
  /**
   * Whether to include the agent before explicit configuration (R30). This can use filesystem detection or a
   * fixed default; it does not guarantee that the executable is installed.
   */
  enabledByDefault(readers: MachineReaders): boolean;
  /** Lists every live session this CLI reports. Never throws — a failure comes back classified. */
  listSessions(path: string, deps: MachineDeps): Promise<AgentReading>;
  /** Saved metadata only. The caller establishes absence from the live roster independently. */
  listHistory?(deps: MachineDeps): Promise<HistoryReading>;
  /** Whether saved history remains resumable. Checked on click; checkout requirements are agent-specific. */
  canResume?(session: HistoricalSession, deps: MachineDeps): boolean;
  /**
   * Answer a bounded question as JSON without creating a session visible to the board. Omit this capability if
   * the agent cannot isolate classification from ordinary session discovery (R30).
   */
  classify?(input: ClassifyInput): Promise<ClassifyResult>;
  /**
   * Start work in a checkout and return its dispatch identity (R39). Adapters offering dispatch must support
   * stopping their runs. Automated takeover is a separate future requirement (R15).
   */
  dispatch?(input: DispatchInput): Promise<DispatchResult>;
  /** Stops a session this adapter started, by the short id the dispatch returned. Absent where the CLI cannot. */
  stopDispatch?(path: string, shortId: string): Promise<ReadFailure | null>;
  readonly activity?: ActivitySignal;
}
