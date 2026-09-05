/** One agent CLI the board reads. `id` matches a registered adapter; `path` is the command or a full path. */
export interface AgentConfig {
  id: string;
  path: string;
}

export interface SessionsConfig {
  agents: AgentConfig[];
  /** Matches an issue number in a branch or directory name. The team's convention, so it ships as a default. */
  branchIssuePattern: string;
}

/** Saved work, separate from the live roster: no process, phase, or claim that the work completed. */
export interface HistoricalSession {
  agent: string;
  sessionId: string;
  title: string | null;
  cwd: string;
  branch: string | null;
  issueNumber: number | null;
  /** Canonical remote identity (host/owner/repository), or null when the checkout cannot establish it. */
  repository: string | null;
  updatedAt: number;
}

export type ActivityPhase = 'running' | 'waiting' | 'idle';

/**
 * The last phase an activity signal reported, and when it began. Never a guarantee the session is in it now — an agent CLI does not say what
 * an interactive session is doing, which is why the signal exists at all (`docs/mechanics.md` §20).
 */
export interface SessionActivity {
  phase: ActivityPhase;
  /** Epoch milliseconds the duration counts from: the turn's own prompt for a running session, the reporting event for the rest. */
  since: number;
  /** The hook event the phase came from, so a card can say what it saw. */
  event: string;
}

export interface Session {
  /** The adapter that reported it — what tells two CLIs' sessions apart on one board. */
  agent: string;
  sessionId: string;
  /**
   * The session's own process, where the CLI reports one. It is what ties a session to the VS Code window holding it:
   * the process is a child of that window's extension host, and `cwd` cannot say, because a session moves with the
   * work. A background session carries a pid too, but its parent is a shell rather than a window.
   */
  pid: number | null;
  /**
   * What the session calls itself: the developer's own title where they set one, else the one the agent wrote for
   * itself. Null when it has neither. `details.name` is no substitute — Claude derives that from the directory.
   */
  title: string | null;
  cwd: string;
  startedAt: number;
  branch: string | null;
  issueNumber: number | null;
  /**
   * When the session's transcript was last written, or null when there is none. Not liveness: a live session can
   * have a transcript hours old, or none at all, so `docs/mechanics.md` §3 forbids deriving running from it.
   */
  transcriptWrittenAt: number | null;
  /** Null when no signal has reported on this session, or reported nothing the board recognises. */
  activity: SessionActivity | null;
  /**
   * The agent's own word that this session has ended. Never inferred from silence or from a transcript's age
   * (R24, `docs/mechanics.md` §3), and false for every agent whose CLI does not report an end.
   */
  finished: boolean;
  /**
   * Words only one agent reports, kept for display so a field like Claude's background-session `status` never becomes
   * a column every adapter has to fake. The board reads `name` and `shortId` in the label ladder after `title`, and
   * `state` or `status` as the CLI's own word where no phase was reported. An adapter may carry any others.
   */
  details: Record<string, string>;
}

/**
 * A classified failure from an adapter, a work source, or the configuration. `subject` names which one, so a board
 * reading several says which it could not reach; `kind` is that subject's own vocabulary.
 */
export interface ReadFailure {
  subject: string;
  kind: string;
  message: string;
  remedy: string;
}

/**
 * Always a snapshot, never a failure: with several CLIs configured, one being absent must not hide the sessions
 * the others reported. A CLI that could not be read contributes a failure and no sessions.
 */
export interface SessionsSnapshot {
  sessions: Session[];
  failures: ReadFailure[];
  /** Set when branchIssuePattern is unusable, so the board can say why nothing linked. */
  patternError: string | null;
  fetchedAt: string;
}
