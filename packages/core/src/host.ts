import type { MachineReaders } from './machine.js';
import type { HistoricalSession, ReadFailure, Session } from './types.js';

/** One window of a host application, with the roots it has open. The host adapter decides what else a window carries. */
export interface HostWindow {
  folders: string[];
}

/**
 * Which surface inside a window holds a session. Only a tab can be revealed by id; a sidebar can only be brought
 * forward.
 */
export type Surface = 'tab' | 'sidebar';

export interface SessionSurface {
  agent: string;
  sessionId: string;
  /** Folder or workspace file used to raise the window. */
  root: string;
  surface: Surface;
}

/** Session-opening refusals with distinct remedies. */
export type OpenRefusal =
  | 'unknown-session'
  | 'other-agent'
  | 'no-extension'
  | 'no-surface'
  | 'attach-only'
  | 'settling'
  | 'window-closed'
  | 'unnamed-window'
  | 'history-unavailable'
  | 'sessions-unreadable'
  | 'resume-pending'
  | 'card-active'
  | 'elsewhere-not-allowed'
  | 'no-checkout'
  | 'already-here'
  | 'no-agent'
  | 'checkout-elsewhere';

/**
 * Session surface: reveal tabs by ID; for sidebars, focus the window and identify the session. A resume's
 * `worktree` is the checkout it must run in, present when `root` is the repository window instead (R44).
 */
export type OpenRoute =
  ({ agentHome?: string; resumeToken?: string } & (
  | { route: 'resume-here'; session: HistoricalSession; root: string; expiresAt: number; worktree?: string }
  | { route: 'resume-elsewhere'; session: HistoricalSession; root: string; expiresAt: number; newWindow: boolean; worktree?: string }
  | { route: 'reveal-here'; session: Session; root: string }
  | { route: 'reveal-elsewhere'; session: Session; root: string }
  | { route: 'sidebar-here'; session: Session; root: string }
  | { route: 'sidebar-elsewhere'; session: Session; root: string }
  | { route: 'unknown-surface-here'; session: Session; root: string }
  | { route: 'unknown-surface-elsewhere'; session: Session; root: string }
  // Open a checkout without a session. Deduplicate by card key (R18).
  | { route: 'open-checkout'; key: string; root: string; newWindow: boolean }
  // Start in the performing window; no session ID exists for cross-window routing yet (mechanics M51).
  | { route: 'start-session'; key: string; agent: string; root: string; prompt: string | null }));

/**
 * Deduplicate in-flight session routes by session ID. Checkout routes use operation and card; starts also
 * include agent. Distinct operations and agents must not suppress one another's requests.
 */
export function routeKey(route: OpenRoute): string {
  if (!('key' in route)) {
    return route.session.sessionId;
  }

  return route.route === 'start-session' ? `${route.route}:${route.key}:${route.agent}` : `${route.route}:${route.key}`;
}

/** Request to open a card checkout without a session. */
export interface CheckoutRequest {
  /** Card key used to deduplicate routes. */
  key: string;
  root: string;
  /** Requesting window workspace file, otherwise its first workspace folder. */
  workspaceRoot: string | null;
  /** Full folder sets, because only a window with exactly one folder can be raised by naming that folder. */
  liveWindows: readonly HostWindow[];
}

/** Request to start a session in the requesting window. Opening another checkout is a separate operation. */
export interface StartRequest {
  key: string;
  agent: string;
  root: string;
  /** Unsent prompt for a new session, or null for a bare session (R42). */
  prompt: string | null;
  /** Requesting window workspace file, otherwise its first workspace folder. */
  workspaceRoot: string | null;
  /** Whether the agent's own extension is available in this window to start a session. */
  extensionReady: boolean;
}

/** One agent a host offers a new session for. `takesPrompt` is false where its only way in accepts no arguments. */
export interface StartableAgent {
  agent: string;
  takesPrompt: boolean;
}

export interface OpenRequest {
  sessionId: string;
  sessions: readonly Session[];
  /** Saved metadata re-read and validated by the agent on this click. A live session of the same id takes precedence. */
  historicalSession?: HistoricalSession;
  /** Which surface holds each session, from every window's own persisted state (`docs/mechanics.md` M21). */
  surfaces: readonly SessionSurface[];
  /** Window identified by session PID and extension-host parent PID (mechanics M22). Null when no window parent matches. */
  window: HostWindow | null;
  /** Folders a live window has open. The fallback for confirming a recorded root when the join names no window. */
  liveRoots: readonly string[];
  /** Full folder sets are needed to distinguish a standalone resume directory from a multi-root workspace. */
  liveWindows?: readonly HostWindow[];
  /** Requesting window workspace file, otherwise its first workspace folder. */
  workspaceRoot: string | null;
  /** Whether the agent's own extension is available in the host to perform a reveal. */
  extensionReady: boolean;
  /**
   * Whether this request was routed from another window. Do not forward it again; stale surface records could
   * cause a routing loop (M44, M45).
   */
  handedOver?: boolean;
  /** Epoch milliseconds, which is what a session's age is measured against. */
  now: number;
}

export type OpenPlan = OpenRoute | { refusal: OpenRefusal; message: string };

export type OpenOutcome = 'opened' | 'no-tab';

/** The windows a host has open now, and the one holding a given session where the host can say. */
export interface HostWindows {
  /** Windows that answer now. A record that outlived its window is not a window. */
  live: HostWindow[];
  /** The window holding the session that was asked about, or null where the host cannot tie one to it. */
  holding: HostWindow | null;
}

/** Host-specific state, window discovery, and session-opening operations. residentRoutes require a client in that host. */
export interface HostAdapter {
  readonly id: string;
  /** Parses this host's entry in the configuration, or names what is wrong with it. */
  configure(raw: unknown): ReadFailure | null;
  /** Preload window and surface data to reduce open latency. */
  prime(deps: MachineReaders): void;
  /** Which windows are open, and which one is running this session. */
  windows(session: Session | undefined, deps: MachineReaders): Promise<HostWindows>;
  /** Which surface in which window holds each session, from the host's own records. */
  surfaces(deps: MachineReaders): Promise<SessionSurface[]>;
  /** A route to the session, or a named refusal with its remedy. Pure, and judged against this host's own settings. */
  plan(request: OpenRequest): OpenPlan;
  /** Optional checkout-opening plan. */
  planCheckout?(request: CheckoutRequest): OpenPlan;
  /** Optional new-session plan. */
  planStart?(request: StartRequest): OpenPlan;
  /** Host-wide agent start capabilities, including prompt support. */
  startable?(): readonly StartableAgent[];
  /** Sessions this host can open (R14). */
  openable(sessions: readonly Session[], history?: readonly HistoricalSession[]): string[];
  /** Routes requiring a host client. Omit open if all routes require a resident client. */
  readonly residentRoutes: readonly OpenRoute['route'][];
  /** Routes this adapter can perform from a headless process. Absent where every route is resident. */
  open?(route: OpenRoute, deps: MachineReaders): Promise<OpenOutcome>;
  /** Optional session-surface release for takeover. */
  release?(session: Session, deps: MachineReaders): Promise<void>;
  /** The editor distribution's URI scheme for browser links, where the host has one (R14). */
  uriScheme?(): string;
}
