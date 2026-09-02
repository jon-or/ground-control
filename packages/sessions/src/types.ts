/** One agent CLI the board reads. `id` matches a registered provider; `path` is the command or a full path. */
export interface AgentConfig {
  id: string;
  path: string;
}

export interface SessionsConfig {
  agents: AgentConfig[];
  /** Matches an issue number in a branch or directory name. The team's convention, so it ships as a default. */
  branchIssuePattern: string;
}

export interface Session {
  /** The provider that reported it — what tells two CLIs' sessions apart on one board. */
  agent: string;
  sessionId: string;
  /** Only some sessions carry a short id; Claude gives one to `--bg` sessions and not to interactive ones. */
  shortId: string | null;
  name: string | null;
  cwd: string;
  kind: string;
  startedAt: number;
  status: string | null;
  state: string | null;
  branch: string | null;
  issueNumber: number | null;
  /**
   * When the session's transcript was last written, or null when there is none. Not liveness: a live session can
   * have a transcript hours old, or none at all, so `docs/mechanics.md` §3 forbids deriving running from it.
   */
  transcriptWrittenAt: number | null;
}

export type FailureKind = 'agent-missing' | 'agent-failed' | 'bad-response' | 'unknown-agent';

export interface Failure {
  /** Which CLI failed. A board reading several must say which one it could not reach. */
  agent: string;
  kind: FailureKind;
  message: string;
  remedy: string;
}

/**
 * Always a snapshot, never a failure: with several CLIs configured, one being absent must not hide the sessions
 * the others reported. A CLI that could not be read contributes a failure and no sessions.
 */
export interface SessionsSnapshot {
  sessions: Session[];
  failures: Failure[];
  /** Set when branchIssuePattern is unusable, so the board can say why nothing linked. */
  patternError: string | null;
  fetchedAt: string;
}
