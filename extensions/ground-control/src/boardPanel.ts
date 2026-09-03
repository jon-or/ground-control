import * as vscode from 'vscode';
import type { Client, Hub } from '@ground-control/hub';
import type { ClientMessage, HubMessage, LaneId, Snapshot, SnapshotMessage } from '@ground-control/core';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { readHubConfig, vscodeSettings, userDirOf } from './config.js';
import { promptForLogins } from './identity.js';
import { hub } from './hubClient.js';
import { agentExtensionReady, boardRoot, perform, refuse } from './resident.js';
import { host } from './registry.js';

export const VIEW_TYPE = 'groundControl.board';

export type Outbound = { type: 'loading' } | SnapshotMessage;

type Inbound =
  | { type: 'refresh' }
  | { type: 'openIssue'; number: number }
  | { type: 'openPullRequest'; number: number }
  | { type: 'moveCard'; key: string; lane: LaneId }
  | { type: 'openSession'; sessionId: string };


function nonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * The board, as a client. It renders what the hub sends, forwards what the developer does, and carries out the
 * routes only something inside this window can perform. Every decision about what is on the board is the hub's.
 */
export class BoardPanel {
  static current: BoardPanel | undefined;

  readonly #panel: vscode.WebviewPanel;
  readonly #extensionUri: vscode.Uri;
  readonly #disposables: vscode.Disposable[] = [];
  readonly #hub: Hub;
  readonly #home = homedir();
  readonly #userDir: string;
  #client: Client | undefined;
  #disposed = false;
  /** The webview is torn down when the tab goes background, so the last snapshot is replayed on return. */
  #last: Snapshot | undefined;
  /** A dismissed identity prompt stays dismissed, or every refresh reopens the box. */
  #promptDismissed = false;
  /** The event also fires on focus, so the visibility the board acted on last is kept to tell the two apart. */
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

    return {
      panel: new BoardPanel(panel, context.extensionUri, userDirOf(context)),
      created: true,
    };
  }

  /**
   * VS Code defers deserialization until a restored tab is materialized, so a board can be opened before its
   * restored twin appears. The older instance is disposed here rather than left holding a connection.
   */
  static revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): void {
    BoardPanel.current?.dispose();

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    };

    new BoardPanel(panel, context.extensionUri, userDirOf(context));
  }

  constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, userDir: string) {
    this.#panel = panel;
    this.#extensionUri = extensionUri;
    this.#userDir = userDir;
    this.#hub = hub(this.#home);
    this.#panel.webview.html = this.#html();

    BoardPanel.current = this;

    this.#panel.webview.onDidReceiveMessage((msg: Inbound) => this.#onWebview(msg), undefined, this.#disposables);

    this.#panel.onDidChangeViewState(
      () => {
        // The event also fires when the tab merely gains or loses focus. Only a change of visibility is acted on:
        // telling the hub twice per focus toggle would restart its timers and its periodic read would never fire.
        if (this.#panel.visible === this.#visible) {
          return;
        }

        this.#visible = this.#panel.visible;
        this.#tell({ type: 'watching', watching: this.#visible });
      },
      undefined,
      this.#disposables,
    );

    this.#panel.onDidDispose(() => this.dispose(), undefined, this.#disposables);

    this.#post({ type: 'loading' });
    this.#connect();
  }

  #connect(): void {
    this.#client = this.#hub.connect(
      {
        // Stable per extension host, not per panel: the install notice is said once per board, and a fresh id on
        // every reopen would say it again and leave a mark nothing ever clears (R25).
        id: `vscode-${process.pid}`,
        hostId: host.id,
        workspaceRoot: boardRoot(),
        residentRoutes: [...host.residentRoutes],
        watching: this.#visible,
      },
      (message) => this.#onHub(message),
    );

    this.#tell({ type: 'configure', config: readHubConfig(vscodeSettings(this.#userDir)) });
  }

  #tell(message: ClientMessage): void {
    if (this.#client) {
      this.#hub.receive(this.#client, message);
    }
  }

  #onWebview(msg: Inbound): void {
    switch (msg.type) {
      case 'refresh':
        this.#tell({ type: 'refresh' });

        return;

      // The webview names the issue, never the URL: the address comes from the snapshot the hub sent.
      case 'openIssue':
        this.#openExternal(this.#issueOf(msg.number)?.url);

        return;

      case 'openPullRequest':
        this.#openExternal(this.#issueOf(msg.number)?.pullRequest?.url);

        return;

      case 'moveCard':
        this.#tell({ type: 'move', key: msg.key, lane: msg.lane });

        return;

      // The webview names the session, never a path or a command line — the same rule as the issue above. Whether
      // the agent's extension is ready is read here, on the click: it activates while a board is up.
      case 'openSession':
        void this.#open(msg.sessionId);

        return;
    }
  }

  async #open(sessionId: string): Promise<void> {
    const extensionReady = await agentExtensionReady();

    this.#tell({ type: 'open', sessionId, extensionReady });
  }

  #issueOf(number: number) {
    return this.#last?.lanes
      .flatMap((lane) => lane.cards)
      .find((card) => card.issue?.number === number)?.issue;
  }

  #openExternal(url: string | undefined): void {
    if (url) {
      void vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  #onHub(message: HubMessage): void {
    if (this.#disposed) {
      return;
    }

    switch (message.type) {
      case 'snapshot':
      case 'changed':
        this.#last = message.snapshot;
        this.#post({ type: 'board', ...message.snapshot });
        void this.#askForLogins(message.snapshot);

        return;

      case 'perform':
        void perform(message.route, () => this.#hub.roster());

        return;

      case 'notice':
        if (message.refusal) {
          void refuse(message.refusal, message.message);

          return;
        }

        void vscode.window.showInformationMessage(message.message);

        return;
    }
  }

  /**
   * The one question the hub cannot ask, because it has no screen. Asked once per board, in place, seeded with
   * whatever the CLI already knew (R26, R28); the answer is a setting, which reaches the hub as a configuration.
   */
  async #askForLogins(snapshot: Snapshot): Promise<void> {
    // Armed by the hub no longer needing them, never by the answer itself: a broadcast can carry a `needs` older
    // than the answer, and re-arming on the answer reopens the box on a developer who has just filled it in (R26).
    if (snapshot.needs === null) {
      this.#promptDismissed = false;

      return;
    }

    if (this.#promptDismissed) {
      return;
    }

    this.#promptDismissed = true;

    await promptForLogins(snapshot.needs.logins.detected);
  }

  refresh(): void {
    this.#promptDismissed = false;
    this.#tell({ type: 'refresh' });
  }

  #post(message: Outbound): void {
    if (this.#disposed) {
      return;
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

    if (this.#client) {
      this.#hub.disconnect(this.#client);
      this.#client = undefined;
    }

    while (this.#disposables.length > 0) {
      this.#disposables.pop()?.dispose();
    }

    this.#panel.dispose();
  }
}
