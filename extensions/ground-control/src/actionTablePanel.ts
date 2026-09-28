import * as vscode from 'vscode';
import { DEFAULT_TEST_BRANCH_PATTERN } from '@ground-control/core';
import { legacyMergeRow, tableToSave } from './actionTable.js';

const SECTION = 'groundControl';
const VIEW_TYPE = 'groundControl.actionTable';
/** Set once the earlier merge settings have been copied into the table, so clearing the table does not bring them back. */
const MIGRATED_KEY = 'groundControl.actionTableMigrated';

/** Messages the table webview sends. */
type PanelMessage = { type: 'ready' } | { type: 'save'; rows: unknown; pattern: unknown };

function nonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Copy the earlier `actions.merge-upstream` settings into the table once (R39). They are no longer declared. */
export async function migrateActionTable(memento: vscode.Memento): Promise<void> {
  if (memento.get<boolean>(MIGRATED_KEY) === true) {
    return;
  }

  const cfg = vscode.workspace.getConfiguration(SECTION);
  const row = legacyMergeRow(cfg.get<unknown>('actions.merge-upstream.enabled'), cfg.get<unknown>('actions.merge-upstream.prompt'));

  if (row !== null && cfg.inspect<unknown[]>('actions.table')?.globalValue === undefined) {
    await cfg.update('actions.table', [row], vscode.ConfigurationTarget.Global);
  }

  await memento.update(MIGRATED_KEY, true);
}

/** Edits `actions.table` and `actions.testBranchPattern` as one table with a save (R39). The settings stay the record. */
export class ActionTablePanel {
  static #current: ActionTablePanel | undefined;

  readonly #panel: vscode.WebviewPanel;
  readonly #extensionUri: vscode.Uri;
  readonly #disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri): void {
    if (ActionTablePanel.#current !== undefined) {
      ActionTablePanel.#current.#panel.reveal();

      return;
    }

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Ground Control Actions', vscode.ViewColumn.Active, {
      enableScripts: true,
      // Unsaved rows live in the page, which a hidden tab would otherwise throw away.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });

    ActionTablePanel.#current = new ActionTablePanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.#panel = panel;
    this.#extensionUri = extensionUri;
    panel.webview.html = this.#html();

    this.#disposables.push(
      panel.onDidDispose(() => this.#dispose()),
      panel.webview.onDidReceiveMessage((message: PanelMessage) => void this.#receive(message)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`${SECTION}.actions.table`) || event.affectsConfiguration(`${SECTION}.actions.testBranchPattern`)) {
          this.#send();
        }
      }),
    );
  }

  async #receive(message: PanelMessage): Promise<void> {
    if (message.type === 'ready') {
      this.#send();

      return;
    }

    if (message.type !== 'save') {
      return;
    }

    const checked = tableToSave(message.rows, message.pattern);

    if ('failure' in checked) {
      void this.#panel.webview.postMessage({ type: 'failed', message: checked.failure });

      return;
    }

    const cfg = vscode.workspace.getConfiguration(SECTION);

    try {
      await cfg.update('actions.table', checked.rows, vscode.ConfigurationTarget.Global);
      // The default stays unset, so a changed default reaches everyone who never chose one.
      await cfg.update(
        'actions.testBranchPattern',
        checked.pattern === DEFAULT_TEST_BRANCH_PATTERN ? undefined : checked.pattern,
        vscode.ConfigurationTarget.Global,
      );
      void this.#panel.webview.postMessage({ type: 'saved' });
    } catch (error: unknown) {
      void this.#panel.webview.postMessage({ type: 'failed', message: `Could not save: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  /** The saved table, as the settings hold it. */
  #send(): void {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    const rows = cfg.get<unknown>('actions.table', []);
    const pattern = cfg.get<unknown>('actions.testBranchPattern', DEFAULT_TEST_BRANCH_PATTERN);

    void this.#panel.webview.postMessage({
      type: 'table',
      rows: Array.isArray(rows) ? rows : [],
      pattern: typeof pattern === 'string' ? pattern : DEFAULT_TEST_BRANCH_PATTERN,
    });
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
<link href="${media('actions.css')}" rel="stylesheet">
<title>Ground Control Actions</title>
</head>
<body>
<main id="table"></main>
<script nonce="${n}" src="${media('actions.js')}"></script>
</body>
</html>`;
  }

  #dispose(): void {
    ActionTablePanel.#current = undefined;

    for (const disposable of this.#disposables) {
      disposable.dispose();
    }
  }
}
