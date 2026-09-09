import type { Lane, LaneId } from './board.js';
import type { HubConfig } from './config.js';
import type { OpenRefusal, OpenRoute, StartableAgent } from './host.js';
import type { LogEntry } from './log.js';
import type { ReadFailure } from './types.js';

/**
 * Client protocol version. Increment for incompatible message changes. Bundle replacement has a separate
 * freshness check and can restart the hub without a protocol change.
 */
export const PROTOCOL = 1;

/** Everything a board needs to render. The hub owns what is on it; it owns no work item's own state. */
export interface Snapshot {
  lanes: Lane[];
  issues: {
    count: number;
    matched: number;
    totalAssigned: number;
    notOnProject: number;
    truncated: boolean;
    fetchedAt: string;
  } | null;
  sessions: { count: number; patternError: string | null; fetchedAt: string } | null;
  /** Ids of the sessions this client can be asked to open. Another client's host has its own answer. */
  openable: string[];
  /**
   * The agents this client's host offers a new session for. Host-wide rather than per-card, because which agents
   * have a way in is a fact of the host: every card with a checkout gets the same answer, and a card without one
   * gets no start item at all. Empty for a client resident in nothing — a browser cannot start a session (R42).
   */
  startable: StartableAgent[];
  /** What the hub did about the activity signal, when there is something the developer has to be told (R25). */
  hooks: { notice: string } | null;
  failures: ReadFailure[];
  /** Whether the last read of a source failed. A misconfigured host is worth saying, but it is not a stale board. */
  stale: boolean;
  /** What the hub cannot proceed without and no client has given it yet, seeded with whatever it could detect. */
  needs: { logins: { detected: string[] } } | null;
  /** When this snapshot was taken, for the staleness line a browser overlay needs (R25). */
  fetchedAt: string;
}

/**
 * What a client says about itself when it connects. `hostId` is null for a client that is resident in nothing — a
 * browser overlay — and `residentRoutes` is what this client can perform in the application it lives in.
 */
export interface ClientHello {
  id: string;
  hostId: string | null;
  workspaceRoot: string | null;
  residentRoutes: string[];
  /** A hidden board is not watched, and the hub stops polling when no client is watching (R35). */
  watching: boolean;
}

/** A connected board, as the hub and its transport both hold it. The hub keeps no transport, only what to call. */
export interface Client {
  readonly id: string;
}

export type ClientMessage =
  | { type: 'hello'; hello: ClientHello }
  // `acknowledge` asks for the activity install's outcome back as a notice. Set only where a developer changed the
  // setting themselves: a client pushes its configuration on every connect, and those must pass in silence.
  | { type: 'configure'; config: HubConfig; acknowledge?: boolean }
  | { type: 'watching'; watching: boolean }
  | { type: 'refresh' }
  | { type: 'move'; key: string; lane: LaneId }
  // `extensionReady` rides on the open rather than on the hello: an editor extension activating is something that
  // happens while a board is up, and a board that connected before it finished would plan every open without it.
  // `handedOver` says the board raised this window and passed it the session, rather than a developer clicking a
  // link. The hub plans it as it plans any other open, and refuses to send it on to a third window (M45).
  | { type: 'open'; sessionId: string; extensionReady: boolean; handedOver?: boolean }
  // Paid classification: validate the card key and rate-limit repeated requests.
  | { type: 'retriage'; key: string }
  // Manual action request. Bypasses automatic enablement/history, retaining safety and concurrency checks.
  // Positive daily limits apply; zero disables automatic starts only (R32, R39).
  | { type: 'runAction'; key: string }
  // Taking back a run in flight. Never a lane change and never a refusal of the card, only the session it started.
  | { type: 'stopAction'; key: string }
  // A window on the card's own checkout, and no agent in it. The card and nothing else: the root is whatever the
  // hub resolved for it, and the board window's own root is read off this client's hello.
  | { type: 'openCheckout'; key: string }
  // The directory the developer chose for a card nothing has run on. The path is theirs — it comes from the
  // editor's own folder picker — and the hub refuses one that is not a checkout of that card's repository.
  | { type: 'setCheckout'; key: string; root: string }
  // A new session for the card, in this client's own window. `extensionReady` rides on it for the reason `open`'s
  // does, and the agent is named because a host may offer several and the developer picked one from the menu.
  | { type: 'startSession'; key: string; agent: string; extensionReady: boolean }
  // A viewer opening or closing. Nothing about the hub's log crosses to a client that has not sent this: until
  // one does, the hub holds no subscriber, reads no file, and sends nothing.
  | { type: 'watchLog'; watching: boolean };

export type HubMessage =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'changed'; snapshot: Snapshot }
  | { type: 'perform'; route: OpenRoute }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string; refusal?: OpenRefusal }
  // Only ever to a client that asked. The first carries the tail of `hub.log`, so a viewer opened after a failure
  // shows the failure; every one after it carries the single line that was just written.
  | { type: 'log'; entries: LogEntry[] };

/** What the webview parses. The snapshot flattened, because the board script reads its fields directly. */
export type SnapshotMessage = { type: 'board' } & Snapshot;

/**
 * Everything an editor board's panel posts into its webview. Here rather than in the extension so both halves of
 * that contract are one type: the panel and the script are different languages in different processes, and a field
 * renamed on one side of a hand-written literal is silent — it renders a board with a dead control (`testing.md`).
 */
export type BoardMessage =
  | { type: 'loading' }
  // Whether the hub's log is arriving. The panel's to say, because the control's state cannot be read off the
  // editor's output panel (`mechanics.md` M34) and a board reopened has to be told rather than remember.
  | { type: 'logs'; streaming: boolean }
  // The standing Archived choice, which the extension holds: a webview's own state dies with the tab it was in.
  | { type: 'showArchived'; shown: boolean }
  | SnapshotMessage;
