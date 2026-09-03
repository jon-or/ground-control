import { homedir } from 'node:os';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { activityNotice } from '@ground-control/hub';
import { BoardPanel, VIEW_TYPE } from './boardPanel.js';
import { SECTION, readHubConfig, vscodeSettings, userDirOf } from './config.js';
import { hub, disposeHub } from './hubClient.js';
import { migrateLaneMemory } from './migrate.js';


export function activate(context: vscode.ExtensionContext): void {
  // On activation, which for this extension means the developer opened the board or ran one of its commands — or
  // reopened a window that had the board tab in it. A developer who never opens it is never activated (PRD §2).
  const home = homedir();

  migrateLaneMemory(context.globalState, home);
  hub(home).configure(readHubConfig(vscodeSettings(userDirOf(context))));

  context.subscriptions.push(
    // One path for settings, and it runs whether or not a board is open: "turn this off to remove those entries" is
    // a claim the extension does not honour until the next reload otherwise (R34).
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(SECTION)) {
        return;
      }

      const resynced = hub(home).configure(readHubConfig(vscodeSettings(userDirOf(context))));

      // What it observed, never what it intended: `up-to-date` means there was nothing of ours to change. Only the
      // signal earns a message here — every other setting shows its effect on the board itself.
      if (resynced) {
        void vscode.window.showInformationMessage(
          resynced.failure?.message ??
            activityNotice({ plan: resynced.plan, wanted: resynced.wanted, unreported: 0 }) ??
            `Session activity hooks are already ${resynced.wanted === 'install' ? 'installed' : 'absent'}.`,
        );
      }
    }),
    vscode.commands.registerCommand('groundControl.openBoard', () => {
      BoardPanel.show(context);
    }),
    vscode.commands.registerCommand('groundControl.refresh', () => {
      // Creating the panel already reads both sources; refreshing again here would double every first invocation.
      const { panel, created } = BoardPanel.show(context);

      if (!created) {
        panel.refresh();
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
    { dispose: disposeHub },
  );
}

export function deactivate(): void {}
