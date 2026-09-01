import * as vscode from 'vscode';
import { fetchAssignedIssues } from '@ground-control/github';
import type { AssignedIssues, Failure } from '@ground-control/github';
import { readConfig, refreshIntervalMs } from './config.js';
import { promptForLogins } from './identity.js';

export const VIEW_TYPE = 'groundControl.board';

type CardsMessage = { type: 'cards' } & AssignedIssues;
type ErrorMessage = { type: 'error'; kind: Failure['kind']; message: string; remedy: string };
type Outbound = { type: 'loading' } | CardsMessage | ErrorMessage;

function nonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class BoardPanel {
  static current: BoardPanel | undefined;

  readonly #panel: vscode.WebviewPanel;
  readonly #extensionUri: vscode.Uri;
  readonly #disposables: vscode.Disposable[] = [];
  #timer: NodeJS.Timeout | undefined;
  #disposed = false;
  /** The webview is torn down when the tab goes background, so both are replayed on return. */
  #lastCards: CardsMessage | undefined;
  #lastError: ErrorMessage | undefined;
  #inFlight: Promise<void> | undefined;
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
          const card = this.#lastCards?.cards.find((c) => c.number === msg.number);

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
        if (!this.#panel.visible) {
          return;
        }

        if (this.#lastCards) {
          void this.#panel.webview.postMessage(this.#lastCards);
        }

        if (this.#lastError) {
          void this.#panel.webview.postMessage(this.#lastError);
        }
      },
      undefined,
      this.#disposables,
    );

    this.#panel.onDidDispose(() => this.dispose(), undefined, this.#disposables);

    this.#timer = setInterval(() => void this.refresh(), refreshIntervalMs());

    void this.refresh();
  }

  /** Coalesces callers: the interval, the command, and the webview button share one in-flight read. */
  refresh(): Promise<void> {
    this.#inFlight ??= this.#refreshOnce().finally(() => {
      this.#inFlight = undefined;
    });

    return this.#inFlight;
  }

  async #refreshOnce(): Promise<void> {
    this.#post({ type: 'loading' });

    let cfg = readConfig();

    if (cfg.logins.length === 0) {
      const logins = this.#promptDismissed ? [] : await promptForLogins(cfg.ghPath);

      if (this.#disposed) {
        return;
      }

      if (logins.length === 0) {
        this.#promptDismissed = true;

        this.#post({
          type: 'error',
          kind: 'no-logins',
          message: 'The board does not know which GitHub account is yours.',
          remedy: 'Set groundControl.github.logins in Settings, or run Ground Control: Refresh Board to be asked again.',
        });

        return;
      }

      this.#promptDismissed = false;
      cfg = { ...cfg, logins };
    }

    const result = await fetchAssignedIssues(cfg);

    if (this.#disposed) {
      return;
    }

    if (!result.ok) {
      this.#post({ type: 'error', ...result.error });
      return;
    }

    this.#post({ type: 'cards', ...result.value });
  }

  #post(message: Outbound): void {
    if (this.#disposed) {
      return;
    }

    // A failed refresh must not erase a board the developer can still read; the webview marks it stale instead.
    if (message.type === 'cards') {
      this.#lastCards = message;
      this.#lastError = undefined;
    }

    if (message.type === 'error') {
      this.#lastError = message;
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

    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }

    while (this.#disposables.length > 0) {
      this.#disposables.pop()?.dispose();
    }

    this.#panel.dispose();
  }
}
