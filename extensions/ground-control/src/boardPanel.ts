import * as vscode from 'vscode';
import { agentOfSession, basename, sessionOf } from '@ground-control/core';
import type { BoardMessage, CardCheckout, ClientMessage, LaneId, Snapshot } from '@ground-control/core';
import { readHubConfig, userDirOf } from './config.js';
import { promptForLogins } from './identity.js';
import { client } from './hubClient.js';
import type { HubClient } from './hubClient.js';
import { agentExtensionReady } from './resident.js';
import { attachTo } from './attach.js';
import { OPEN_CHANGES } from './changes.js';
import { boardLog } from './logging.js';

export const VIEW_TYPE = 'groundControl.board';

/**
 * Where the Archived toggle is kept. The webview's own state dies with the tab, and the choice is the developer's
 * standing one - a board opened tomorrow draws the lane it was left drawing.
 */
export const SHOW_ARCHIVED_KEY = 'groundControl.showArchived';

/** Long enough for a first render on a cold extension host, short enough that nobody sits looking at nothing. */
const BLANK_AFTER_MS = 10_000;

/** What the webview drew, which is the only report that its script ran at all. */
export interface Drawn {
  lanes: number;
  cards: number;
  notices: number;
  meta: string;
}

type Inbound =
  | ({ type: 'drew' } & Drawn)
  // Posted once per run of the board script. The only signal a webview has reloaded: the panel is not told, no
  // visibility changes, and the button would otherwise sit reading off while this window was streaming.
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openIssue'; number: number }
  | { type: 'openPullRequest'; number: number }
  | { type: 'moveCard'; key: string; lane: LaneId }
  | { type: 'retriage'; key: string }
  | { type: 'runAction'; key: string }
  | { type: 'stopAction'; key: string }
  | { type: 'openSession'; sessionId: string }
  | { type: 'attachSession'; sessionId: string }
  | { type: 'openChanges'; key: string }
  | { type: 'openCheckout'; key: string }
  | { type: 'chooseCheckout'; key: string }
  | { type: 'startSession'; key: string; agent: string }
  | { type: 'toggleLogs' }
  | { type: 'showBoardLog' }
  | { type: 'openSettings' }
  | { type: 'setShowArchived'; shown: boolean };


/**
 * What the editor tab is called, so two open at once are told apart: the issue where there is one, the checkout's
 * own directory where there is not. A card whose sessions are spread over more than one checkout names the one
 * that was picked, because which of them the diff came from is otherwise invisible.
 */
function cardLabel(card: { issueNumber: number | null; issue: { title: string } | null }, checkout: CardCheckout): string {
  const named =
    card.issueNumber === null
      ? basename(checkout.root)
      : card.issue
        ? `#${card.issueNumber} ${card.issue.title}`
        : `#${card.issueNumber}`;

  return checkout.only ? named : `${named} (${basename(checkout.root)})`;
}

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
  readonly #client: HubClient;
  readonly #userDir: string;
  readonly #memento: vscode.Memento;
  #disposed = false;
  /** The webview is torn down when the tab goes background, so the last snapshot is replayed on return. */
  #last: Snapshot | undefined;
  /** A dismissed identity prompt stays dismissed, or every refresh reopens the box. */
  #promptDismissed = false;
  /** The event also fires on focus, so the visibility the board acted on last is kept to tell the two apart. */
  #visible = true;
  #drew: Drawn | null = null;
  #blankTimer: NodeJS.Timeout | undefined;

  static show(context: vscode.ExtensionContext): BoardPanel {
    const existing = BoardPanel.current;

    if (existing) {
      existing.#panel.reveal();

      return existing;
    }

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Ground Control', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });

    return new BoardPanel(panel, context.extensionUri, userDirOf(context), context.globalState);
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

    new BoardPanel(panel, context.extensionUri, userDirOf(context), context.globalState);
  }

  constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, userDir: string, memento: vscode.Memento) {
    this.#panel = panel;
    this.#extensionUri = extensionUri;
    this.#userDir = userDir;
    this.#memento = memento;
    this.#client = client()!;
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
        this.#client.watching(this.#visible);

        // A board only draws while it is visible, so the wait for its first render starts and stops with the tab.
        if (this.#visible) {
          this.#watchForBlank();
        } else {
          this.#stopWatchingForBlank();
        }
      },
      undefined,
      this.#disposables,
    );

    this.#panel.onDidDispose(() => this.dispose(), undefined, this.#disposables);

    this.#post({ type: 'loading' });
    this.#watchForBlank();
    this.#connect();
  }

  #connect(): void {
    this.#disposables.push(
      this.#client.onSnapshot((snapshot) => this.#render(snapshot)),
      // Fired by the client, so a board and the command that runs with no board open cannot disagree about it.
      this.#client.onStreamingChanged((streaming) => this.#post({ type: 'logs', streaming })),
    );

    const known = this.#client.snapshot;

    // What the window already knows, before the read this board's arrival triggers lands. A board opened second in
    // a long-running window would sit on its loading line for a whole refresh interval otherwise.
    if (known) {
      this.#render(known);
    }

    this.#client.configure(readHubConfig(this.#userDir));
    this.#client.watching(this.#visible);
  }

  #tell(message: ClientMessage): void {
    this.#client.send(message);
  }

  #onWebview(msg: Inbound): void {
    switch (msg.type) {
      case 'ready':
        this.#postLogs();
        this.#post({ type: 'showArchived', shown: this.#memento.get<boolean>(SHOW_ARCHIVED_KEY, false) });

        return;

      case 'drew':
        this.#drew = msg;
        this.#stopWatchingForBlank();

        return;

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

      case 'retriage':
        this.#tell({ type: 'retriage', key: msg.key });

        return;

      case 'runAction':
        this.#tell({ type: 'runAction', key: msg.key });

        return;

      case 'stopAction':
        this.#tell({ type: 'stopAction', key: msg.key });

        return;

      // Whether the agent's extension is ready is read here, on the click: it activates while a board is up.
      case 'openSession':
        void this.#open(msg.sessionId);

        return;

      case 'attachSession':
        this.#attach(msg.sessionId);

        return;

      case 'openChanges':
        void this.#changes(msg.key);

        return;

      case 'openCheckout':
        this.#tell({ type: 'openCheckout', key: msg.key });

        return;

      case 'chooseCheckout':
        void this.#chooseCheckout(msg.key);

        return;

      // The agent's own extension, not Claude's: a start fires that agent's command, so it is that extension the
      // window has to have. Read on the click for the reason `openSession`'s is.
      case 'startSession':
        void agentExtensionReady(msg.agent).then((extensionReady) =>
          this.#tell({ type: 'startSession', key: msg.key, agent: msg.agent, extensionReady }),
        );

        return;

      case 'toggleLogs':
        this.#client.toggleHubLog();

        return;

      // Nothing to toggle: this channel is written whether or not anybody is looking, so the control only reveals.
      case 'showBoardLog':
        boardLog().show(true);

        return;

      // Scoped to this extension's own settings: the board's are spread over a dozen keys under one prefix, and a
      // developer landing in the whole settings tree has to find them.
      case 'openSettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:groundcontrol.ground-control');

        return;

      case 'setShowArchived':
        void this.#memento.update(SHOW_ARCHIVED_KEY, msg.shown);

        return;
    }
  }

  /** What the webview last reported drawing. A board that never draws leaves this null, which is the only tell. */
  get drew(): Drawn | null {
    return this.#drew;
  }

  /**
   * Report a missing drew acknowledgement once while the panel is visible (R25). With retainContextWhenHidden
   * disabled, a hidden webview may not run its script; do not time out hidden panels.
   */
  #watchForBlank(): void {
    if (this.#blankTimer !== undefined || this.#drew !== null || !this.#panel.visible) {
      return;
    }

    this.#blankTimer = setTimeout(() => {
      this.#blankTimer = undefined;

      if (this.#drew === null && this.#panel.visible) {
        void vscode.window.showErrorMessage(
          'The board opened but never drew: its script did not run. Reload the window, and report it if it happens again.',
        );
      }
    }, BLANK_AFTER_MS);
  }

  #stopWatchingForBlank(): void {
    if (this.#blankTimer !== undefined) {
      clearTimeout(this.#blankTimer);
      this.#blankTimer = undefined;
    }
  }

  async #open(sessionId: string): Promise<void> {
    const extensionReady = await agentExtensionReady(agentOfSession(this.#last, sessionId));

    this.#tell({ type: 'open', sessionId, extensionReady });
  }

  /** The row's own door into a run, which `attachTo` owns so a click in the browser does exactly the same thing. */
  #attach(sessionId: string): void {
    const session = sessionOf(this.#last, sessionId);

    if (session === null || !attachTo(session)) {
      void vscode.window.showWarningMessage('That run is no longer on the board, or is not one the board can attach to.');
    }
  }

  async #changes(key: string): Promise<void> {
    const card = this.#last?.lanes.flatMap((lane) => lane.cards).find((candidate) => candidate.key === key);

    if (!card) {
      void vscode.window.showWarningMessage('That card is no longer on the board. Refresh and try again.');

      return;
    }

    const checkout = card.checkout;

    if (!checkout) {
      void vscode.window.showWarningMessage('That card has no checkout to read changes from.');

      return;
    }

    await vscode.commands.executeCommand(OPEN_CHANGES, checkout.root, cardLabel(card, checkout), key);
  }

  /**
   * The folder the developer says this card's work happens in. Picked here rather than typed anywhere: a path is
   * the one thing no board may name on its own, and the hub refuses one that is not a checkout of the card's
   * repository — so the picker supplies the gesture and the hub supplies the check.
   */
  async #chooseCheckout(key: string): Promise<void> {
    const card = this.#last?.lanes.flatMap((lane) => lane.cards).find((candidate) => candidate.key === key);

    if (!card) {
      void vscode.window.showWarningMessage('That card is no longer on the board. Refresh and try again.');

      return;
    }

    const [picked] = (await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Use this checkout',
      title: `Checkout for ${card.issue?.repository ?? ''}#${card.issueNumber ?? ''}`,
      ...(card.checkout ? { defaultUri: vscode.Uri.file(card.checkout.root) } : {}),
    })) ?? [];

    if (picked !== undefined) {
      this.#tell({ type: 'setCheckout', key, root: picked.fsPath });
    }
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

  #render(snapshot: Snapshot): void {
    if (this.#disposed) {
      return;
    }

    this.#last = snapshot;
    this.#post({ type: 'board', ...snapshot });
    void this.#askForLogins(snapshot);
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

  #postLogs(): void {
    this.#post({ type: 'logs', streaming: this.#client.streamingHubLog });
  }

  #post(message: BoardMessage): void {
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
  <button id="board-menu" type="button"></button>
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
    this.#stopWatchingForBlank();

    if (BoardPanel.current === this) {
      BoardPanel.current = undefined;
    }

    // The connection outlives the board: this window stays a client so a setting still reaches the hub with no
    // board open (R34). What ends with the board is the watching, and so the polling (R35).
    this.#client.watching(false);

    while (this.#disposables.length > 0) {
      this.#disposables.pop()?.dispose();
    }

    this.#panel.dispose();
  }
}
