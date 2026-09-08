import type { Lane, LaneId } from './board.js';
import type { HubConfig } from './config.js';
import type { OpenRefusal, OpenRoute } from './host.js';
import type { LogEntry } from './log.js';
import type { ReadFailure } from './types.js';

/**
 * The shape of everything below. An integer, bumped only when a client that speaks the old number would misread the
 * new one — a patch release never restarts a running hub.
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
  // link. The hub plans it as it plans any other open, and refuses to send it on to a third window (§45).
  | { type: 'open'; sessionId: string; extensionReady: boolean; handedOver?: boolean }
  // The one message that spends money, so the hub checks the key names a card on the board and holds a cooldown
  // rather than taking it on trust the way every other, idempotent, message is taken.
  | { type: 'retriage'; key: string }
  // The developer asking for a card's action by hand. It runs every gate a dispatch the board made itself runs, and
  // the ceilings too — what it skips is the setting, because the click is the opt-in for this one card (R32).
  | { type: 'runAction'; key: string }
  // Taking back a run in flight. Never a lane change and never a refusal of the card, only the session it started.
  | { type: 'stopAction'; key: string }
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
  // editor's output panel (`mechanics.md` §34) and a board reopened has to be told rather than remember.
  | { type: 'logs'; streaming: boolean }
  | SnapshotMessage;
