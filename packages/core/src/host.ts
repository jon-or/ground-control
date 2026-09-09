import type { MachineReaders } from './machine.js';
import type { HistoricalSession, ReadFailure, Session } from './types.js';

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
 * Where a session can be reached. A tab is revealed by id in the window holding it; a sidebar has no such command, so
 * the whole of what can be done is bringing its window forward and saying which session is in it.
 */
export type OpenRoute =
  | { route: 'resume-here'; session: HistoricalSession; root: string; expiresAt: number }
  | { route: 'resume-elsewhere'; session: HistoricalSession; root: string; expiresAt: number; newWindow: boolean }
  | { route: 'reveal-here'; session: Session; root: string }
  | { route: 'reveal-elsewhere'; session: Session; root: string }
  | { route: 'sidebar-here'; session: Session; root: string }
  | { route: 'sidebar-elsewhere'; session: Session; root: string }
  | { route: 'unknown-surface-here'; session: Session; root: string }
  | { route: 'unknown-surface-elsewhere'; session: Session; root: string }
  // A window on a card's checkout, opened so the developer can work there. Keyed by the card, because there is no
  // session id to hold it by and one is what stops a second click (R18).
  | { route: 'open-checkout'; key: string; root: string; newWindow: boolean }
  // A new session for the card, in the window performing this and no other: nothing can name a session that does
  // not exist yet, so there is no way to hand one to another window (`docs/mechanics.md` §51). Keyed by the card.
  | { route: 'start-session'; key: string; agent: string; root: string; prompt: string | null };

/**
 * What a route is held by while it is in flight. A second fire at a tab already on its way is a second agent on one
 * transcript (`mechanics.md` §11), and a second `code` on one checkout is a second window — so both are dropped, by
 * the session where a route has one and by the card where it does not.
 *
 * A card is not enough on its own: two verbs are keyed by card, and a start names an agent besides. Holding by the
 * card alone would make opening a card's window swallow the click that starts a session in it, and one agent's
 * start swallow the other's — a click that does nothing and says nothing.
 */
export function routeKey(route: OpenRoute): string {
  if (!('key' in route)) {
    return route.session.sessionId;
  }

  return route.route === 'start-session' ? `${route.route}:${route.key}:${route.agent}` : `${route.route}:${route.key}`;
}

/**
 * What is asked when a card is to be opened rather than a session. It carries no session and no surfaces: a
 * directory is reached by `code` and nothing inside a window records it.
 */
export interface CheckoutRequest {
  /** The card this is for, which is what the route is keyed by. */
  key: string;
  root: string;
  /** The board window's own root, chosen as a recorded one is: its workspace file where it has one, else its folder. */
  workspaceRoot: string | null;
  /** Full folder sets, because only a window with exactly one folder can be raised by naming that folder. */
  liveWindows: readonly HostWindow[];
}

/**
 * What is asked when a card is to be given a new session. Its own type rather than `CheckoutRequest` widened: a
 * start reads no window but the one asking, since it is refused anywhere a checkout would merely be opened.
 */
export interface StartRequest {
  key: string;
  agent: string;
  root: string;
  /** What the new session is prefilled with, or null for a bare one. Never sent — the developer sends it (R16). */
  prompt: string | null;
  /** The board window's own root. A start runs here or nowhere, so this is what decides the whole route. */
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
  /** Which surface holds each session, from every window's own persisted state (`docs/mechanics.md` §21). */
  surfaces: readonly SessionSurface[];
  /**
   * The window holding this session's own process, from the parent-process join (`docs/mechanics.md` §22). Exact
   * where it answers, and null where the parent is not a window's extension host — then the record is all there is.
   */
  window: HostWindow | null;
  /** Folders a live window has open. The fallback for confirming a recorded root when the join names no window. */
  liveRoots: readonly string[];
  /** Full folder sets are needed to distinguish a standalone resume directory from a multi-root workspace. */
  liveWindows?: readonly HostWindow[];
  /** The board window's own root, chosen as a recorded one is: its workspace file where it has one, else its folder. */
  workspaceRoot: string | null;
  /** Whether the agent's own extension is available in the host to perform a reveal. */
  extensionReady: boolean;
  /**
   * Whether the board raised this window and handed it the session, rather than a developer clicking a link. A
   * hand-over is revealed by the window that received it or refused there: routing one onward is how two windows
   * pass a session back and forth, because the surface record a plan reads can be a minute old (§44, §45).
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

/**
 * One application a session can show in. It owns the host's persisted state, its window enumeration, and the verbs
 * for reaching a session in it. Routes only a client resident in the host can perform are named in `residentRoutes`.
 */
export interface HostAdapter {
  readonly id: string;
  /** Parses this host's entry in the configuration, or names what is wrong with it. */
  configure(raw: unknown): ReadFailure | null;
  /** Warms whatever `windows` and `surfaces` read, so an open pays the cheap half only. */
  prime(deps: MachineReaders): void;
  /** Which windows are open, and which one is running this session. */
  windows(session: Session | undefined, deps: MachineReaders): Promise<HostWindows>;
  /** Which surface in which window holds each session, from the host's own records. */
  surfaces(deps: MachineReaders): Promise<SessionSurface[]>;
  /** A route to the session, or a named refusal with its remedy. Pure, and judged against this host's own settings. */
  plan(request: OpenRequest): OpenPlan;
  /** A route to a card's checkout, the same way. Absent where the host has no way to be pointed at a directory. */
  planCheckout?(request: CheckoutRequest): OpenPlan;
  /** A route to a new session on a card, the same way. Absent where no agent in this host can be asked to start. */
  planStart?(request: StartRequest): OpenPlan;
  /**
   * The agents this host can start a new session for, and whether the prompt reaches one. Host-wide rather than
   * per-card: which agents have a way in is a fact of this host, and every card with a checkout has the same answer.
   */
  startable?(): readonly StartableAgent[];
  /** Which of these sessions this host offers to open. Another host's answer is its own (R14). */
  openable(sessions: readonly Session[], history?: readonly HistoricalSession[]): string[];
  /**
   * Routes only a client resident in the host can perform, named so the hub forwards them rather than attempting
   * them. A host whose every route is resident performs none itself, and omits `open`.
   */
  readonly residentRoutes: readonly OpenRoute['route'][];
  /** Routes this adapter can perform from a headless process. Absent where every route is resident. */
  open?(route: OpenRoute, deps: MachineReaders): Promise<OpenOutcome>;
  /** Closes the surface holding a session so it can be handed back. Absent where the host cannot do it yet. */
  release?(session: Session, deps: MachineReaders): Promise<void>;
}
