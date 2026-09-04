import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { BoardPanel, VIEW_TYPE } from './boardPanel.js';
import type { Drawn } from './boardPanel.js';
import { bundlePathOf } from '@ground-control/hub';
import { writeBundle } from './bundle.js';
import { SECTION, readHubConfig, userDirOf } from './config.js';
import { disposeClient, startClient } from './hubClient.js';
import { migrateLaneMemory } from './migrate.js';
import { registerOverlayCommands } from './overlay.js';
import { registerUriHandler } from './openUri.js';
import type { Snapshot } from '@ground-control/core';

/**
 * What `vscode.extensions.getExtension(...).exports` hands back. Readable by any extension in the window, so it is
 * two reads and nothing that acts: the snapshot this window's board renders, and what the board reports drawing.
 */
export interface GroundControl {
  snapshot(): Snapshot | undefined;
  drew(): Drawn | null;
}

export function activate(context: vscode.ExtensionContext): GroundControl {
  // On activation, which for this extension means the developer opened the board or ran one of its commands — or
  // reopened a window that had the board tab in it. A developer who never opens it is never activated (PRD §2).
  const home = homedir();
  const version = String((context.extension.packageJSON as { version?: unknown }).version ?? '0.0.0');

  migrateLaneMemory(context.globalState, home);

  const bundle = bundlePathOf(home);

  try {
    writeBundle(home, context.extensionPath, version, bundle);
  } catch (error) {
    // Everything else in this window still works, and a hub already on disk from an earlier run still starts. What
    // must not happen is the commands, the board, and the settings listener going with it.
    void vscode.window.showErrorMessage(`The board could not write its background process to ${bundle}: ${String(error)}`);
  }

  // Connected on activation rather than when a board opens, because turning the signal off has to take effect with
  // no board on screen (R34). Nothing is polled until a board says it is watching (R35).
  const client = startClient(home, bundle);

  client.configure(readHubConfig(userDirOf(context)));

  context.subscriptions.push(
    // One path for settings, and it runs whether or not a board is open. The hub answers a change the developer
    // made with what its install observed, which is the only thing here worth a message of its own.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(SECTION)) {
        client.configure(readHubConfig(userDirOf(context)), true);
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
    ...registerOverlayCommands(context, home, bundle),
    // The browser board's way in. Registered here so a link activates this window whether or not a board is open.
    registerUriHandler(),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        BoardPanel.revive(panel, context);
      },
    }),
    { dispose: () => BoardPanel.current?.dispose() },
    { dispose: disposeClient },
  );

  // What this window has, so an integration test running inside this host reads the board a developer would see
  // rather than a screenshot of one. Nothing in the product reads it.
  return { snapshot: () => client.snapshot, drew: () => BoardPanel.current?.drew ?? null };
}

export function deactivate(): void {}
