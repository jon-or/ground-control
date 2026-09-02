import * as vscode from 'vscode';
import { BoardPanel, VIEW_TYPE } from './boardPanel.js';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
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
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        BoardPanel.revive(panel, context);
      },
    }),
    { dispose: () => BoardPanel.current?.dispose() },
  );
}

export function deactivate(): void {}
