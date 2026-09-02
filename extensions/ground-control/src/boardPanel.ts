import * as vscode from 'vscode';
import { mergeBoard } from '@ground-control/board';
import type { BoardCard } from '@ground-control/board';
import { fetchAssignedIssues } from '@ground-control/github';
import type { AssignedIssues, Failure as GithubFailure } from '@ground-control/github';
import { fetchSessions } from '@ground-control/sessions';
import type { SessionsSnapshot } from '@ground-control/sessions';
import { readConfig, readSessionsConfig, refreshIntervalMs, sessionIntervalMs } from './config.js';
import { promptForLogins } from './identity.js';

export const VIEW_TYPE = 'groundControl.board';

interface SourceFailure {
  source: 'issues' | 'sessions';
  kind: string;
  message: string;
  remedy: string;
}

interface BoardMessage {
  type: 'board';
  cards: BoardCard[];
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

type Outbound = { type: 'loading' } | BoardMessage;

function nonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class BoardPanel {
  static current: BoardPanel | undefined;

  readonly #panel: vscode.WebviewPanel;
  readonly #extensionUri: vscode.Uri;
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

  static show(extensionUri: vscode.Uri): { panel: BoardPanel; created: boolean } {
    const existing = BoardPanel.current;

    if (existing) {
      existing.#panel.reveal();
      return { panel: existing, created: false };
    }

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Ground Control', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });

    return { panel: new BoardPanel(panel, extensionUri), created: true };
  }

  /**
   * VS Code defers deserialization until a restored tab is materialized, so a board can be opened before its
   * restored twin appears. The older instance is disposed here rather than left holding a refresh timer.
   */
  static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri): void {
    BoardPanel.current?.dispose();

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    };

    new BoardPanel(panel, extensionUri);
  }

  constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.#panel = panel;
    this.#extensionUri = extensionUri;
    this.#panel.webview.html = this.#html();

    BoardPanel.current = this;

    this.#panel.webview.onDidReceiveMessage(
      (msg: { type: string; number?: unknown }) => {
        if (msg.type === 'refresh') {
          void this.refresh();
        }

        if (msg.type === 'openIssue') {
          const card = this.#issues?.cards.find((c) => c.number === msg.number);

          if (card) {
            void vscode.env.openExternal(vscode.Uri.parse(card.url));
          }
        }
      },
      undefined,
      this.#disposables,
    );

    this.#panel.onDidChangeViewState(
      () => {
        if (this.#panel.visible && this.#lastBoard) {
          void this.#panel.webview.postMessage(this.#lastBoard);
        }
      },
      undefined,
      this.#disposables,
    );

    this.#panel.onDidDispose(() => this.dispose(), undefined, this.#disposables);

    // Two cadences, because the two sources move at different speeds: a session's state changes in seconds, and
    // `claude agents --json` costs a quarter of a second locally, while the GitHub read costs a network round trip.
    this.#timers.push(
      setInterval(() => void this.#refreshIssues(), refreshIntervalMs()),
      setInterval(() => void this.#refreshSessions(), sessionIntervalMs()),
    );

    this.#post({ type: 'loading' });
    void this.refresh();
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

    this.#post({
      type: 'board',
      cards: mergeBoard(this.#issues?.cards ?? [], this.#sessions?.sessions ?? []),
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link href="${media('board.css')}" rel="stylesheet">
<title>Ground Control</title>
</head>
<body>
<header>
  <h1>Ground Control</h1>
  <div id="meta"></div>
  <button id="refresh" type="button">Refresh</button>
</header>
<div id="notices"></div>
<main id="cards" aria-live="polite"></main>
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

    while (this.#timers.length > 0) {
      clearInterval(this.#timers.pop());
    }

    while (this.#disposables.length > 0) {
      this.#disposables.pop()?.dispose();
    }

    this.#panel.dispose();
  }
}
