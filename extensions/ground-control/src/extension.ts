import * as vscode from 'vscode';
import { BoardPanel, VIEW_TYPE } from './boardPanel.js';
import { SECTION } from './config.js';
import { pruneActivityMarkers, showSettingChanged, syncActivitySignals } from './activity.js';

export function activate(context: vscode.ExtensionContext): void {
  // On activation, which for this extension means the developer opened the board or ran one of its commands — or
  // reopened a window that had the board tab in it. A developer who never opens it is never activated (PRD §2).
  syncActivitySignals();
  pruneActivityMarkers();

  context.subscriptions.push(
    // The setting has to take effect when it is changed, or "turn this off to remove those entries" is a claim the
    // extension does not honour until the next reload (R34).
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(`${SECTION}.installSessionHooks`)) {
        return;
      }

      // What it observed, never what it intended: `up-to-date` means there was nothing of ours to change.
      showSettingChanged(syncActivitySignals());

      void BoardPanel.current?.refresh();
    }),
    vscode.commands.registerCommand('groundControl.openBoard', () => {
      BoardPanel.show(context);
    }),
    vscode.commands.registerCommand('groundControl.refresh', () => {
      // Creating the panel already reads GitHub; refreshing again here would double every first invocation.
      const { panel, created } = BoardPanel.show(context);

      if (!created) {
        void panel.refresh();
      }
    }),
    // Turns the setting off and stops there: the configuration listener above owns the removal and its message, so
    // there is one path that changes the hooks rather than two that have to agree.
    vscode.commands.registerCommand('groundControl.removeSessionHooks', () =>
      vscode.workspace
        .getConfiguration(SECTION)
        .update('installSessionHooks', false, vscode.ConfigurationTarget.Global),
    ),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        BoardPanel.revive(panel, context);
      },
    }),
    { dispose: () => BoardPanel.current?.dispose() },
  );
}

export function deactivate(): void {}
