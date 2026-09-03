import type { MachineDeps } from './machine.js';
import type { Session } from './types.js';

/** One window of a host application, with the roots it has open. The host adapter decides what else a window carries. */
export interface HostWindow {
  folders: string[];
}

/** Which surface inside a window holds a session. Only a tab can be revealed by id; a sidebar can only be brought forward. */
export type Surface = 'tab' | 'sidebar';

export interface SessionSurface {
  agent: string;
  sessionId: string;
  /** What the host is given to bring the window forward: its folder, or its workspace file. */
  root: string;
  surface: Surface;
}

/** Why the board would not open a session. Each case has a different remedy, so each is named separately. */
export type OpenRefusal =
  | 'unknown-session'
  | 'other-agent'
  | 'no-extension'
  | 'no-surface'
  | 'settling'
  | 'window-closed'
  | 'unnamed-window'
  | 'elsewhere-not-allowed';

/**
 * Where a session can be reached. A tab is revealed by id in the window holding it; a sidebar has no such command, so
 * the whole of what can be done is bringing its window forward and saying which session is in it.
 */
export type OpenRoute =
  | { route: 'reveal-here'; session: Session; root: string }
  | { route: 'reveal-elsewhere'; session: Session; root: string }
  | { route: 'sidebar-here'; session: Session; root: string }
  | { route: 'sidebar-elsewhere'; session: Session; root: string }
  | { route: 'unknown-surface-here'; session: Session; root: string }
  | { route: 'unknown-surface-elsewhere'; session: Session; root: string };

export interface OpenRequest {
  sessionId: string;
  sessions: readonly Session[];
  /** Which surface holds each session, from every window's own persisted state (`docs/mechanics.md` §21). */
  surfaces: readonly SessionSurface[];
  /**
   * The window holding this session's own process, from the parent-process join (`docs/mechanics.md` §22). Exact
   * where it answers, and null where the parent is not a window's extension host — then the record is all there is.
   */
  window: HostWindow | null;
  /** Folders a live window has open. The fallback for confirming a recorded root when the join names no window. */
  liveRoots: readonly string[];
  /** The board window's own root, chosen as a recorded one is: its workspace file where it has one, else its folder. */
  workspaceRoot: string | null;
  /** R27: whether the board may bring another window forward, which moves the developer's focus. */
  mayOpenWindow: boolean;
  /** Whether the agent's own extension is available in the host to perform a reveal. */
  extensionReady: boolean;
  /** Epoch milliseconds, which is what a session's age is measured against. */
  now: number;
}

export type OpenPlan = OpenRoute | { refusal: OpenRefusal; message: string };

export type OpenOutcome = 'opened' | 'no-tab';

/**
 * One application a session can show in. It owns the host's persisted state, its window enumeration, and the verbs
 * for reaching a session in it. Routes only a client resident in the host can perform are named in `residentRoutes`.
 */
export interface HostAdapter {
  readonly id: string;
  /** Windows that answer now, with the roots each has open. A record that outlived its window is not a window. */
  windows(deps: MachineDeps): Promise<HostWindow[]>;
  /** Which surface in which window holds each session, from the host's own records. */
  surfaces(deps: MachineDeps): Promise<SessionSurface[]>;
  /** A route to the session, or a named refusal with its remedy. Pure. */
  plan(request: OpenRequest): OpenPlan;
  /** Routes this adapter can perform from a headless process. */
  open(route: OpenRoute, deps: MachineDeps): Promise<OpenOutcome>;
  /** Closes the surface holding a session so it can be handed back. */
  release(session: Session, deps: MachineDeps): Promise<void>;
  readonly residentRoutes: readonly OpenRoute['route'][];
}
