import type { MachineDeps, MachineReaders, ReadText } from './machine.js';
import type { HistoricalSession, ReadFailure, Session, SessionActivity } from './types.js';

export interface HistoryReading {
  sessions: HistoricalSession[];
  failure: ReadFailure | null;
}

/** Return valid sessions alongside failures for malformed entries (R2). */
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

/** Optional agent activity signal. Without one, sessions have no observed phase. */
export interface ActivitySignal {
  /** Pure installation/removal plan; the caller performs filesystem writes. */
  plan(input: ActivityPlanInput): ActivityPlan;
  /** Agent settings updated by plan; the caller backs up the file first. */
  settingsPath(home: string): string;
  /** Activity marker directory, created on install and retained on removal. */
  watchDir(home: string): string;
  /** Last observed phase, or null when unavailable. */
  read(home: string, sessionId: string, readText: ReadText, now?: number): SessionActivity | null;
  /**
   * Optional activity writer. Update changed bytes and retain the file after hook removal for sessions using
   * cached settings.
   */
  readonly writer?: { path(home: string): string; source: string };
}

/** Isolated JSON classification. Adapters must keep classifier sessions off the board (mechanics M31). */
export interface ClassifyInput {
  /** The CLI, from the same configuration the roster read spawns. */
  path: string;
  /** Caller-supplied classification ID. */
  sessionId: string;
  model: string | null;
  systemPrompt: string;
  prompt: string;
  schema: unknown;
  /** Isolated directory that prevents loading developer project settings. */
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
}

/** Return classified failures instead of throwing (R24). */
export type ClassifyResult = { value: unknown } | { failure: ReadFailure };

/**
 * Agent work in the developer checkout, using developer settings and visible session history (R2). The agent
 * assigns the session ID (mechanics M33).
 */
export interface DispatchInput {
  /** The CLI, from the same configuration the roster read spawns. */
  path: string;
  /** Work prompt. Claude interprets a leading slash as a command (mechanics M33); other adapters may differ. */
  prompt: string;
  /** Requested display name. Adapter support varies; Claude uses it and Codex currently ignores it. */
  name: string;
  /** Recorded session checkout; never inferred from a branch name. */
  cwd: string;
  /** Explicit dispatch permission mode; bare Claude --bg defaults to auto (M33). */
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

/** Agent-specific session transport, parsing, history, and failure messages. */
export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly defaultPath: string;
  /** One selected storage profile per adapter instance; changing it preserves dispatch ownership. */
  readonly storage?: {
    readonly environment: string;
    readonly defaultDirectory: string;
    configure(root: string): void;
  };
  /**
   * Whether to include the agent before explicit configuration (R30). This can use filesystem detection or a
   * fixed default; it does not guarantee that the executable is installed.
   */
  enabledByDefault(readers: MachineReaders): boolean;
  /** List live sessions, returning classified failures instead of throwing. */
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
  /** Dispatch must declare supported modes so the hub can refuse before reading card context. */
  readonly dispatchPermissions?: readonly string[];
  /** Stop a session started by this adapter using its dispatch ID. */
  stopDispatch?(path: string, shortId: string): Promise<ReadFailure | null>;
  readonly activity?: ActivitySignal;
}
