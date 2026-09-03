import type { Lane, LaneId } from './board.js';
import type { HubConfig } from './config.js';
import type { OpenRefusal, OpenRoute } from './host.js';
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

export type ClientMessage =
  | { type: 'hello'; hello: ClientHello }
  | { type: 'configure'; config: HubConfig }
  | { type: 'watching'; watching: boolean }
  | { type: 'refresh' }
  | { type: 'move'; key: string; lane: LaneId }
  // `extensionReady` rides on the open rather than on the hello: an editor extension activating is something that
  // happens while a board is up, and a board that connected before it finished would plan every open without it.
  | { type: 'open'; sessionId: string; extensionReady: boolean };

export type HubMessage =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'changed'; snapshot: Snapshot }
  | { type: 'perform'; route: OpenRoute }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string; refusal?: OpenRefusal };

/** What the webview parses. The snapshot flattened, because the board script reads its fields directly. */
export type SnapshotMessage = { type: 'board' } & Snapshot;
