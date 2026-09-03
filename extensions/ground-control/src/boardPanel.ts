import * as vscode from 'vscode';
import { assignLanes, mergeBoard, nextMemory, readMemory, withPlacement } from '@ground-control/board';
import type { CardMemory, Lane, LaneId } from '@ground-control/board';
import { fetchAssignedIssues } from '@ground-control/github';
import type { AssignedIssues, Failure as GithubFailure } from '@ground-control/github';
import { readActivity, rosterIsStale, unreportedSessions } from '@ground-control/agent-claude';
import { diskReaders, fetchSessions } from '@ground-control/core';
import type { ActivityChange, Session, SessionsSnapshot } from '@ground-control/core';
import { PLACEMENTS, openableSessions } from '@ground-control/host-vscode';
import { activityNotice, afterInstall, announce, lanesPathOf, makeLaneStore, makeMarkStore, read, watchDir } from '@ground-control/hub';
import type { ActivityState, LaneStore, MarkStore } from '@ground-control/hub';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { readBoardRules, readBoardStatuses, readConfig, readSessionsConfig, refreshIntervalMs, sessionIntervalMs } from './config.js';
import { promptForLogins } from './identity.js';
import { activityState } from './activity.js';
import { agents } from './registry.js';
import { openSession, primeOpen } from './resident.js';
import type { Machine } from './resident.js';

export const VIEW_TYPE = 'groundControl.board';
/** Where the lane placements used to live, before they became one record per machine (R8). Migrated once, then cleared. */
const MEMORY_KEY = 'groundControl.cardMemory';

export interface SourceFailure {
  source: 'issues' | 'sessions' | 'hooks';
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
  /** Ids of the sessions the board offers to open (R14). Another CLI's session has no command to open it with. */
  openable: string[];
  /** What the board did about its activity hooks, when there is something the developer has to know (R25). */
  hooks: { notice: string } | null;
  failures: SourceFailure[];
}

export type Outbound = { type: 'loading' } | BoardMessage;

type Inbound =
  | { type: 'refresh' }
  | { type: 'openIssue'; number: number }
  | { type: 'openPullRequest'; number: number }
  | { type: 'moveCard'; key: string; lane: LaneId }
  | { type: 'openSession'; sessionId: string };

/**
 * Where this VS Code keeps its state. `globalStorageUri` is `<user>/User/globalStorage/<extension>`, so the `User`
 * directory two levels above it is the one the running install writes to — assuming the default location would read
 * another install's windows on a portable or Insiders one.
 */
function machineOf(context: vscode.ExtensionContext): Machine {
  return { userDir: dirname(dirname(context.globalStorageUri.fsPath)), home: homedir() };
}

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
  /** The last read came back with no sessions and a failure from every agent, so a hook event has nothing to read. */
  #sessionsUnreadable = false;
  /** A dismissed identity prompt stays dismissed, or the refresh timer reopens the box every interval. */
  #promptDismissed = false;
  /** The webview is torn down when hidden, so polling stops with it. Tracked because the event also fires on focus. */
  #visible = true;
  /** Where this VS Code and Claude Code keep their state — the two directories every read outside the workspace uses. */
  readonly #machine: Machine;
  /** One record per machine, so a card the developer moved on one board is in that lane on every board (R8). */
  readonly #lanes: LaneStore;
  /** What the hub has already done and already said, so an install is announced once per board (R25). */
  readonly #marks: MarkStore;
  /** This board's own name in the marks, so a second window still sees the notice. */
  readonly #client = `vscode-${process.pid}`;
  /** Stored, not per-panel: a session that predates the install still cannot report after a reload (R25). */
  #installedAt: number;

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

    return { panel: new BoardPanel(panel, context.extensionUri, context.globalState, machineOf(context)), created: true };
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

    new BoardPanel(panel, context.extensionUri, context.globalState, machineOf(context));
  }

  constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, memento: vscode.Memento, machine: Machine) {
    this.#panel = panel;
    this.#extensionUri = extensionUri;
    this.#memento = memento;
    this.#machine = machine;
    this.#lanes = makeLaneStore(machine.home);
    this.#marks = makeMarkStore(machine.home);
    this.#panel.webview.html = this.#html();

    this.#migrateMemory();
    this.#installedAt = this.#rememberInstall();

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

        // The webview names the session, never a path or a command line - the same rule as the issue above.
        if (msg.type === 'openSession') {
          openSession(msg.sessionId, this.#sessions?.sessions ?? [], this.#machine).catch((error: unknown) => {
            void vscode.window.showErrorMessage(`Opening the session failed unexpectedly: ${String(error)}`);
          });
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

    for (const agent of agents) {
      if (agent.activity) {
        this.#disposables.push(watchDir(agent.activity.watchDir(this.#machine.home), (c) => this.#onActivity(c)));
      }
    }

    this.#startPolling();
    this.#post({ type: 'loading' });
    void this.refresh();
  }

  /**
   * The lane placements this window stored before they became one record per machine. Moved once, so a developer
   * upgrading keeps the lanes they put their cards in, and cleared so nothing reads two memories again.
   */
  #migrateMemory(): void {
    const stored = this.#memento.get<unknown>(MEMORY_KEY);

    if (stored === undefined) {
      return;
    }

    if (existsSync(lanesPathOf(this.#machine.home))) {
      void this.#memento.update(MEMORY_KEY, undefined);

      return;
    }

    this.#lanes.write(readMemory(stored, readBoardStatuses()));
    void this.#memento.update(MEMORY_KEY, undefined);
  }

  /**
   * What the board has not already said. Installing the signal is something that happened, not a condition, so it is said once and is then old
   * news. Keyed on the install itself, so removing it and putting it back says it again, and per board, because a second window has not read it.
   */
  #announce(state: ActivityState): string | null {
    const notice = activityNotice({
      plan: state.plan,
      wanted: state.wanted,
      unreported: unreportedSessions(this.#sessions?.sessions ?? [], this.#installedAt),
    });

    if (notice === null) {
      return null;
    }

    const { say, next } = announce(this.#marks.read(), this.#client);

    if (!say) {
      return null;
    }

    this.#marks.write(next);

    return notice;
  }

  #rememberInstall(): number {
    const state = activityState();
    const next = afterInstall(this.#marks.read(), state.wanted, state.added, Date.now());

    this.#marks.write(next);

    return next.installedAt ?? 0;
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

  /**
   * A hook reported a change. A session that ended or one the board has never listed moved the list itself, which only the CLI can report;
   * anything else is a phase on a session already up, and re-reading its marker costs a file read instead of a CLI spawn.
   */
  #onActivity(changes: readonly ActivityChange[]): void {
    if (this.#disposed) {
      return;
    }

    const known = new Set(this.#sessions?.sessions.map((session) => session.sessionId) ?? []);
    const stale = rosterIsStale(changes, known, (id) => readActivity(this.#machine.home, id, read) !== null);

    // Not while the CLI is unreadable: it lists nothing, so every batch would be stale and spawn a read that fails
    // again. The timer keeps retrying, which is the one place a read that may fail belongs.
    if (stale && !this.#sessionsUnreadable) {
      void this.#refreshSessions(true);
      return;
    }

    this.#rereadActivity();
  }

  #rereadActivity(): void {
    if (this.#disposed || this.#sessions === undefined) {
      return;
    }

    this.#sessions = {
      ...this.#sessions,
      sessions: this.#sessions.sessions.map((session) => this.#withActivity(session)),
    };

    this.#render();
  }

  #withActivity(session: Session): Session {
    return { ...session, activity: readActivity(this.#machine.home, session.sessionId, read) };
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

  /**
   * `again` is for a change the in-flight read cannot have seen: a session that ended after that read listed it would otherwise stay on the board
   * until the next poll. A timer or the button coalesces instead, because either is a read of whatever is there now.
   */
  #refreshSessions(again = false): Promise<void> {
    if (this.#sessionsInFlight) {
      return again ? this.#sessionsInFlight.then(() => this.#refreshSessions()) : this.#sessionsInFlight;
    }

    this.#sessionsInFlight = this.#readSessions().finally(() => {
      this.#sessionsInFlight = undefined;
    });

    return this.#sessionsInFlight;
  }

  /** The logins the issues on the board were actually read with, which is not the setting when the developer was just prompted for them. */
  #logins: string[] = [];

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

    this.#logins = cfg.logins;

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
    // Off the click path on purpose: what an open needs costs the best part of a second cold and almost nothing once
    // read, and none of it changes on the developer's click. So it is read on the refresh instead.
    primeOpen(this.#machine);

    const snapshot = await fetchSessions(readSessionsConfig(), agents, diskReaders(this.#machine.home));

    if (this.#disposed) {
      return;
    }

    // Always a snapshot: one CLI being unreadable contributes a failure and no sessions, and must not discard the rest. The activity is re-read
    // as it lands, because a poll that began before a hook fired carries the older phase and would put it back until the next event.
    this.#sessions = { ...snapshot, sessions: snapshot.sessions.map((session) => this.#withActivity(session)) };
    this.#sessionsUnreadable = snapshot.sessions.length === 0 && snapshot.failures.length > 0;

    this.#render();
  }

  #memory(): CardMemory {
    return this.#lanes.read(readBoardStatuses());
  }

  /** A lane is the developer's own placement. This and the render's own bookkeeping are all the board ever stores. */
  #moveCard(key: string, lane: LaneId): void {
    this.#lanes.write(withPlacement(this.#memory(), key, lane));
    this.#render();
  }

  /**
   * One message carries the whole board. A source that failed keeps its last good read on screen and contributes a
   * failure instead of an empty list — R24 forbids implying a fetch succeeded, and equally forbids erasing a board
   * the developer can still read.
   */
  #render(): void {
    const failures: SourceFailure[] = [];

    const activity = activityState();

    if (activity.failure) {
      failures.push({ source: 'hooks', kind: activity.failure.kind, message: activity.failure.message, remedy: activity.failure.remedy });
    }

    if (this.#issuesError) {
      failures.push({ source: 'issues', ...this.#issuesError });
    }

    for (const failure of this.#sessions?.failures ?? []) {
      failures.push({ source: 'sessions', ...failure });
    }

    const memory = this.#memory();
    const lanes = assignLanes(
      mergeBoard(this.#issues?.cards ?? [], this.#sessions?.sessions ?? []),
      readBoardRules(this.#logins),
      memory,
    );

    // Only a clean session read proves a session is gone; a failed one reports none, and would discard its placement.
    const sessionsRead = this.#sessions !== undefined && this.#sessions.failures.length === 0;

    this.#lanes.write(nextMemory(lanes, memory, sessionsRead));

    this.#installedAt = this.#rememberInstall();

    const notice = this.#announce(activity);

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
      hooks: notice === null ? null : { notice },
      openable: openableSessions(this.#sessions?.sessions ?? [], PLACEMENTS),
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
