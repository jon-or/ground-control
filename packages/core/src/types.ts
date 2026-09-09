/** One agent CLI the board reads. `id` matches a registered adapter; `path` is the command or a full path. */
export interface AgentConfig {
  id: string;
  path: string;
  /** Legacy fallback when the corresponding triage.model or actions.model field is absent. */
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
  /**
   * The last phase the board saw this session in while it was live, where that reading still stands (R6). Absent
   * otherwise.
   */
  retained?: RetainedActivity;
}

export type ActivityPhase = 'running' | 'waiting' | 'idle';

/** Retained activity after the process disappears; invalidated by explicit finish or card departure (R6, R9). */
export interface RetainedActivity {
  phase: ActivityPhase;
  /** The hook event the phase came from, and epoch milliseconds of that event — what the reading is dated against. */
  event: string;
  at: number;
}

/** Last observed activity phase and start time, not a guarantee of current state (mechanics M20). */
export interface SessionActivity {
  phase: ActivityPhase;
  /**
   * Epoch milliseconds the duration counts from: the turn's own prompt for a running session, the reporting event
   * for the rest.
   */
  since: number;
  /** Reporting event time in epoch milliseconds, distinct from the running interval start. */
  at: number;
  /** The hook event the phase came from, so a card can say what it saw. */
  event: string;
}

export interface Session {
  /** The adapter that reported it — what tells two CLIs' sessions apart on one board. */
  agent: string;
  sessionId: string;
  /** Session PID used to identify its extension-host parent. Background sessions may have a shell parent instead. */
  pid: number | null;
  /**
   * Developer title, otherwise agent-generated title, or null. Claude details.name is directory-derived and is not
   * a title.
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
  /** Transcript write time, or null. Its age does not establish liveness (mechanics M3). */
  transcriptWrittenAt: number | null;
  /** Null when no signal has reported on this session, or reported nothing the board recognises. */
  activity: SessionActivity | null;
  /**
   * Explicit agent-reported finish; never inferred from silence or transcript age. False when the agent cannot
   * report completion (R24, mechanics M3).
   */
  finished: boolean;
  /** Terminal attachment ID for detached sessions. Null for editor sessions opened by reveal. */
  attachId: string | null;
  /**
   * Adapter-specific display fields. Labels use name and shortId after title; normalized state/status is a
   * fallback when no phase exists. Additional fields are allowed.
   */
  details: Record<string, string>;
}

/** Adapter, source, or configuration failure. subject identifies the component; kind is component-specific. */
export interface ReadFailure {
  subject: string;
  kind: string;
  message: string;
  remedy: string;
  /** Expected to recover automatically. The hub retries with cached data during the transient-error grace period. */
  transient?: boolean;
}

/** Combined session results and failures; an unavailable agent does not hide sessions from others. */
export interface SessionsSnapshot {
  sessions: Session[];
  failures: ReadFailure[];
  /** Set when branchIssuePattern is unusable, so the board can say why nothing linked. */
  patternError: string | null;
  fetchedAt: string;
}
