import type { Lane, LaneId } from './board.js';
import type { HubConfig } from './config.js';
import type { DetailSubject, ItemDetail } from './detail.js';
import type { OpenRefusal, OpenRoute, StartableAgent } from './host.js';
import type { LogEntry } from './log.js';
import type { ReadFailure } from './types.js';

/**
 * Client protocol version. Increment for incompatible message changes. Bundle replacement has a separate
 * freshness check and can restart the hub without a protocol change.
 */
export const PROTOCOL = 1;

/** Authoritative route safety without exposing excluded roster records. */
export interface SessionCheck {
  allowed: boolean;
  targetActive: boolean;
  cardActive: boolean;
  /** Accepted storage profile, included only for an authorized target. */
  agentHome?: string;
}

/** Board display state computed by the hub; source item state remains externally owned. */
export interface Snapshot {
  lanes: Lane[];
  issues: {
    count: number;
    matched: number;
    totalAssigned: number;
    notOnProject: number;
    truncated: boolean;
    fetchedAt: string;
    fieldProblem: string | null;
  } | null;
  sessions: { count: number; patternError: string | null; fetchedAt: string } | null;
  /** Session IDs openable by this client host. */
  openable: string[];
  /** Host-wide agent start capabilities. Empty for browser clients, which cannot start sessions (R42). */
  startable: StartableAgent[];
  /** Activity-hook installation notice, when needed (R25). */
  hooks: { notice: string } | null;
  /** Optional for older client snapshots. Shared triage policy; Chrome remains display-only. */
  triage?: { mode: 'off' | 'manual' | 'automatic'; message: string | null; canRequest: boolean };
  /** The connected editor's URI scheme for browser session links; absent means `vscode` (R14). */
  editor?: { uriScheme: string };
  failures: ReadFailure[];
  /** Source-read failure state; host configuration errors do not imply stale source data. */
  stale: boolean;
  /** Missing required settings, including detected identity suggestions. */
  needs: { logins: { detected: string[] } } | null;
  /** Optional for older hubs. Configured assignee logins; the overlay matches them against a project's filter (R36). */
  owners?: string[];
  /** Snapshot timestamp, not the last successful source-read time (R25). */
  fetchedAt: string;
}

/** Client connection identity and resident operations. Browser clients have no hostId or resident routes. */
export interface ClientHello {
  id: string;
  hostId: string | null;
  workspaceRoot: string | null;
  residentRoutes: string[];
  /** A hidden board is not watched, and the hub stops polling when no client is watching (R35). */
  watching: boolean;
}

/** Connected client identity, independent of transport. */
export interface Client {
  readonly id: string;
}

export type ClientMessage =
  | { type: 'hello'; hello: ClientHello }
  // Request an install-result notice for explicit setting changes; reconnect configuration stays silent.
  | { type: 'configure'; config: HubConfig; acknowledge?: boolean }
  | { type: 'watching'; watching: boolean }
  | { type: 'refresh' }
  | { type: 'move'; key: string; lane: LaneId }
  // Read extensionReady per open request because activation can complete after hello. handedOver prevents routing a cross-window request onward (M45).
  | { type: 'open'; sessionId: string; extensionReady: boolean; handedOver?: boolean; resumeToken?: string }
  // Paid classification: validate the card key and rate-limit repeated requests.
  | { type: 'retriage'; key: string }
  // Manual action request. Bypasses automatic enablement/history, retaining safety and concurrency checks.
  // Positive daily limits apply; zero disables automatic starts only (R32, R39).
  | { type: 'runAction'; key: string }
  // Stop the card action session without changing its lane.
  | { type: 'stopAction'; key: string }
  // Open the hub-resolved checkout. The requesting root comes from client hello.
  | { type: 'openCheckout'; key: string }
  // Editor-selected absolute folder, validated by the hub. Browser clients cannot supply paths.
  | { type: 'setCheckout'; key: string; root: string }
  // Start the selected agent in this client window, checking current extension readiness.
  | { type: 'startSession'; key: string; agent: string; extensionReady: boolean }
  // Subscribe to log reads and streaming, or unsubscribe. No reads occur without a subscriber.
  | { type: 'watchLog'; watching: boolean }
  // Read one card's conversation for display. Answered to the requesting client alone, never broadcast.
  | { type: 'readDetail'; key: string; subject: DetailSubject };

export type HubMessage =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'changed'; snapshot: Snapshot }
  | { type: 'perform'; route: OpenRoute }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string; refusal?: OpenRefusal }
  // Send subscribed clients the log tail first, then individual new lines.
  | { type: 'log'; entries: LogEntry[] }
  // Answer one readDetail. `detail` null with no failure is a subject the source found nothing for.
  | { type: 'detail'; key: string; subject: DetailSubject; detail: ItemDetail | null; failure: string | null };

/** Flattened snapshot fields consumed by the webview. */
export type SnapshotMessage = { type: 'board' } & Snapshot;

/**
 * Typed panel-to-webview messages, shared by extension code and the JavaScript test harness to detect contract
 * mismatches (testing.md).
 */
export type BoardMessage =
  | { type: 'loading' }
  // Report log subscription state from the panel; VS Code exposes no output-panel visibility event (M34).
  | { type: 'logs'; streaming: boolean }
  // Persistent archive visibility from the extension, retained across webview closure.
  | { type: 'showArchived'; shown: boolean }
  // Editor presentation settings; the webview mirrors them as body data attributes for the stylesheet.
  | { type: 'presentation'; animations: boolean }
  // First-run choices still owed; hooks and triage stay off until they are made (R26).
  | { type: 'setup'; pending: boolean }
  // Conversation for the card the webview asked about, or the reason it has none.
  | { type: 'detail'; key: string; subject: DetailSubject; detail: ItemDetail | null; failure: string | null }
  // Whether card controls read a conversation on the board, and the panel width the developer dragged to (R43).
  | { type: 'reading'; enabled: boolean; width: number | null }
  | SnapshotMessage;
