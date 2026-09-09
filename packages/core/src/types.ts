/** One agent CLI the board reads. `id` matches a registered adapter; `path` is the command or a full path. */
export interface AgentConfig {
  id: string;
  path: string;
  /**
   * Which model this agent answers a classification with. The adapter's own vocabulary, so it lives here rather than
   * in `HubConfig`: `core` names no adapter, and a model name is one CLI's word.
   */
  model?: string | undefined;
}

export interface SessionsConfig {
  agents: AgentConfig[];
  /** Matches an issue number in a branch or directory name. The team's convention, so it ships as a default. */
  branchIssuePattern: string;
}

/** Saved work, separate from the live roster: no process and no claim that the work completed. */
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
  /** The last phase the board saw this session in while it was live, where that reading still stands (R6). Absent otherwise. */
  retained?: RetainedActivity;
}

export type ActivityPhase = 'running' | 'waiting' | 'idle';

/**
 * A phase the board read off a session that is no longer live. Kept because a process going away is not the agent saying it finished: an
 * unanswered question is still unanswered, and only the card leaving the developer's hands ends the reading (R6, R9).
 */
export interface RetainedActivity {
  phase: ActivityPhase;
  /** The hook event the phase came from, and epoch milliseconds of that event — what the reading is dated against. */
  event: string;
  at: number;
}

/**
 * The last phase an activity signal reported, and when it began. Never a guarantee the session is in it now — an agent CLI does not say what
 * an interactive session is doing, which is why the signal exists at all (`docs/mechanics.md` M20).
 */
export interface SessionActivity {
  phase: ActivityPhase;
  /** Epoch milliseconds the duration counts from: the turn's own prompt for a running session, the reporting event for the rest. */
  since: number;
  /** Epoch milliseconds of the reporting event itself. What the reading is dated by, which for a running session `since` is not. */
  at: number;
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
  /** The checkout `cwd` sits in, which is above it for a session started in a subdirectory. Null outside a checkout. */
  checkoutRoot: string | null;
  startedAt: number;
  branch: string | null;
  /** Canonical remote identity (host/owner/repository), or null when the checkout cannot establish it. */
  repository: string | null;
  issueNumber: number | null;
  /**
   * When the session's transcript was last written, or null when there is none. Not liveness: a live session can
   * have a transcript hours old, or none at all, so `docs/mechanics.md` M3 forbids deriving running from it.
   */
  transcriptWrittenAt: number | null;
  /** Null when no signal has reported on this session, or reported nothing the board recognises. */
  activity: SessionActivity | null;
  /**
   * The agent's own word that this session has ended. Never inferred from silence or from a transcript's age
   * (R24, `docs/mechanics.md` M3), and false for every agent whose CLI does not report an end.
   */
  finished: boolean;
  /**
   * The id the agent's CLI takes to open this session in a terminal, where the session is one no editor surface can
   * hold — a process the board started detached. Null for a session an editor window holds, which is opened by
   * revealing it instead.
   */
  attachId: string | null;
  /**
   * Words only one agent reports, kept for display so a field like Claude's background-session `status` never becomes
   * a column every adapter has to fake. The board reads `name` and `shortId` in the label ladder after `title`, and
   * `state` or `status` where no phase was reported — an adapter's reading of what its CLI said, not the raw word.
   * An adapter may carry any others.
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
  /**
   * The condition is expected to clear without anybody doing anything — a network that is not back yet. The hub
   * holds the board on its last read and retries rather than saying it, because a laptop waking up is not a notice.
   */
  transient?: boolean;
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
