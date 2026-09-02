import * as vscode from 'vscode';
import { assignLanes, mergeBoard, nextMemory, readMemory, withPlacement } from '@ground-control/board';
import type { CardMemory, Lane, LaneId } from '@ground-control/board';
import { fetchAssignedIssues } from '@ground-control/github';
import type { AssignedIssues, Failure as GithubFailure } from '@ground-control/github';
import { fetchSessions } from '@ground-control/sessions';
import type { SessionsSnapshot } from '@ground-control/sessions';
import { readBoardStatuses, readConfig, readSessionsConfig, refreshIntervalMs, sessionIntervalMs } from './config.js';
import { promptForLogins } from './identity.js';

export const VIEW_TYPE = 'groundControl.board';
const MEMORY_KEY = 'groundControl.cardMemory';

export interface SourceFailure {
  source: 'issues' | 'sessions';
  kind: string;
  message: string;
  remedy: string;
}

export interface BoardMessage {
  type: 'board';
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
  failures: SourceFailure[];
}

export type Outbound = { type: 'loading' } | BoardMessage;

type Inbound =
  | { type: 'refresh' }
  | { type: 'openIssue'; number: number }
  | { type: 'openPullRequest'; number: number }
  | { type: 'moveCard'; key: string; lane: LaneId };

function nonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class BoardPanel {
  static current: BoardPanel | undefined;

  readonly #panel: vscode.WebviewPanel;
  readonly #extensionUri: vscode.Uri;
  readonly #memento: vscode.Memento;
  readonly #disposables: vscode.Disposable[] = [];
  readonly #timers: NodeJS.Timeout[] = [];
  #disposed = false;
  /** The webview is torn down when the tab goes background, so the last board is replayed on return. */
  #lastBoard: BoardMessage | undefined;
  /** Each source keeps its last good read and its last failure, so one failing never blanks the other. */
  #issues: AssignedIssues | undefined;
  #issuesError: GithubFailure | undefined;
  #sessions: SessionsSnapshot | undefined;
  #issuesInFlight: Promise<void> | undefined;
  #sessionsInFlight: Promise<void> | undefined;
  /** A dismissed identity prompt stays dismissed, or the refresh timer reopens the box every interval. */
  #promptDismissed = false;
  /** The webview is torn down when hidden, so polling stops with it. Tracked because the event also fires on focus. */
  #visible = true;

  static show(context: vscode.ExtensionContext): { panel: BoardPanel; created: boolean } {
    const existing = BoardPanel.current;

    if (existing) {
      existing.#panel.reveal();
      return { panel: existing, created: false };
    }

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Ground Control', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });

    return { panel: new BoardPanel(panel, context.extensionUri, context.globalState), created: true };
  }

  /**
   * VS Code defers deserialization until a restored tab is materialized, so a board can be opened before its
   * restored twin appears. The older instance is disposed here rather than left holding a refresh timer.
   */
  static revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): void {
    BoardPanel.current?.dispose();

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    };

    new BoardPanel(panel, context.extensionUri, context.globalState);
  }

  constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, memento: vscode.Memento) {
    this.#panel = panel;
    this.#extensionUri = extensionUri;
    this.#memento = memento;
    this.#panel.webview.html = this.#html();

    BoardPanel.current = this;

    this.#panel.webview.onDidReceiveMessage(
      (msg: Inbound) => {
        if (msg.type === 'refresh') {
          void this.refresh();
        }

        if (msg.type === 'openIssue') {
          const card = this.#issues?.cards.find((c) => c.number === msg.number);

          if (card) {
            void vscode.env.openExternal(vscode.Uri.parse(card.url));
          }
        }

        // The webview names the issue, never the URL: the address comes from the read the extension itself made.
        if (msg.type === 'openPullRequest') {
          const pr = this.#issues?.cards.find((c) => c.number === msg.number)?.pullRequest;

          if (pr) {
            void vscode.env.openExternal(vscode.Uri.parse(pr.url));
          }
        }

        if (msg.type === 'moveCard') {
          this.#moveCard(msg.key, msg.lane);
        }
      },
      undefined,
      this.#disposables,
    );

    this.#panel.onDidChangeViewState(
      () => {
        // The event also fires when the tab merely gains or loses focus. Only a change of visibility is acted on:
        // re-reading GitHub on every focus toggle would restart the interval and the periodic read would never fire.
        if (this.#panel.visible === this.#visible) {
          return;
        }

        this.#visible = this.#panel.visible;

        if (!this.#visible) {
          this.#stopPolling();

          return;
        }

        if (this.#lastBoard) {
          void this.#panel.webview.postMessage(this.#lastBoard);
        }

        void this.refresh();
        this.#startPolling();
      },
      undefined,
      this.#disposables,
    );

    this.#panel.onDidDispose(() => this.dispose(), undefined, this.#disposables);

    this.#startPolling();
    this.#post({ type: 'loading' });
    void this.refresh();
  }

  /**
   * Two cadences, because the sources move at different speeds and cost different amounts: the GitHub read is a
   * network round trip, and each session read spawns a CLI that takes about a fifth of a second.
   */
  #startPolling(): void {
    this.#stopPolling();

    this.#timers.push(
      setInterval(() => void this.#refreshIssues(), refreshIntervalMs()),
      setInterval(() => void this.#refreshSessions(), sessionIntervalMs()),
    );
  }

  #stopPolling(): void {
    while (this.#timers.length > 0) {
      clearInterval(this.#timers.pop());
    }
  }

  /** Reads both sources. Each coalesces on its own, so the button and the two timers never stack up. */
  refresh(): Promise<void> {
    return Promise.all([this.#refreshIssues(), this.#refreshSessions()]).then(() => undefined);
  }

  #refreshIssues(): Promise<void> {
    this.#issuesInFlight ??= this.#readIssues().finally(() => {
      this.#issuesInFlight = undefined;
    });

    return this.#issuesInFlight;
  }

  #refreshSessions(): Promise<void> {
    this.#sessionsInFlight ??= this.#readSessions().finally(() => {
      this.#sessionsInFlight = undefined;
    });

    return this.#sessionsInFlight;
  }

  async #readIssues(): Promise<void> {
    let cfg = readConfig();

    if (cfg.logins.length === 0) {
      const logins = this.#promptDismissed ? [] : await promptForLogins(cfg.ghPath);

      if (this.#disposed) {
        return;
      }

      if (logins.length === 0) {
        this.#promptDismissed = true;
        this.#issuesError = {
          kind: 'no-logins',
          message: 'The board does not know which GitHub account is yours, so it is showing sessions only.',
          remedy: 'Set groundControl.github.logins in Settings, or run Ground Control: Refresh Board to be asked again.',
        };
        this.#render();

        return;
      }

      this.#promptDismissed = false;
      cfg = { ...cfg, logins };
    }

    const result = await fetchAssignedIssues(cfg);

    if (this.#disposed) {
      return;
    }

    if (result.ok) {
      this.#issues = result.value;
      this.#issuesError = undefined;
    } else {
      this.#issuesError = result.error;
    }

    this.#render();
  }

  async #readSessions(): Promise<void> {
    const snapshot = await fetchSessions(readSessionsConfig());

    if (this.#disposed) {
      return;
    }

    // Always a snapshot: one CLI being unreadable contributes a failure and no sessions, and must not discard the rest.
    this.#sessions = snapshot;

    this.#render();
  }

  #memory(): CardMemory {
    return readMemory(this.#memento.get(MEMORY_KEY));
  }

  /** A lane is the developer's own placement. This and the render's own bookkeeping are all the board ever stores. */
  #moveCard(key: string, lane: LaneId): void {
    // Not awaited: the memento's own read already sees this write, so the render below stores the newer memory back.
    void this.#memento.update(MEMORY_KEY, withPlacement(this.#memory(), key, lane));
    this.#render();
  }

  /**
   * One message carries the whole board. A source that failed keeps its last good read on screen and contributes a
   * failure instead of an empty list — R24 forbids implying a fetch succeeded, and equally forbids erasing a board
   * the developer can still read.
   */
  #render(): void {
    const failures: SourceFailure[] = [];

    if (this.#issuesError) {
      failures.push({ source: 'issues', ...this.#issuesError });
    }

    for (const failure of this.#sessions?.failures ?? []) {
      failures.push({ source: 'sessions', ...failure });
    }

    const memory = this.#memory();
    const lanes = assignLanes(
      mergeBoard(this.#issues?.cards ?? [], this.#sessions?.sessions ?? []),
      readBoardStatuses(),
      memory,
    );

    // Only a clean session read proves a session is gone; a failed one reports none, and would discard its placement.
    const sessionsRead = this.#sessions !== undefined && this.#sessions.failures.length === 0;

    void this.#memento.update(MEMORY_KEY, nextMemory(lanes, memory, sessionsRead));

    this.#post({
      type: 'board',
      lanes,
      issues: this.#issues
        ? {
            count: this.#issues.cards.length,
            matched: this.#issues.matched,
            totalAssigned: this.#issues.totalAssigned,
            notOnProject: this.#issues.notOnProject,
            truncated: this.#issues.truncated,
            fetchedAt: this.#issues.fetchedAt,
          }
        : null,
      sessions: this.#sessions
        ? {
            count: this.#sessions.sessions.length,
            patternError: this.#sessions.patternError,
            fetchedAt: this.#sessions.fetchedAt,
          }
        : null,
      failures,
    });
  }

  #post(message: Outbound): void {
    if (this.#disposed) {
      return;
    }

    if (message.type === 'board') {
      this.#lastBoard = message;
    }

    void this.#panel.webview.postMessage(message);
  }

  #html(): string {
    const webview = this.#panel.webview;
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.#extensionUri, 'media', file));
    const n = nonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https://avatars.githubusercontent.com; style-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link href="${media('board.css')}" rel="stylesheet">
<title>Ground Control</title>
</head>
<body>
<header>
  <h1>Ground Control</h1>
  <div id="meta"></div>
  <label id="archived-toggle" hidden><input id="show-archived" type="checkbox"> Show archived (<span id="archived-count">0</span>)</label>
  <button id="refresh" type="button">Refresh</button>
</header>
<div id="notices"></div>
<main id="lanes" aria-live="polite"></main>
<script nonce="${n}" src="${media('board.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;

    if (BoardPanel.current === this) {
      BoardPanel.current = undefined;
    }

    this.#stopPolling();

    while (this.#disposables.length > 0) {
      this.#disposables.pop()?.dispose();
    }

    this.#panel.dispose();
  }
}
