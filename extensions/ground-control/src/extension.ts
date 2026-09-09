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
import { registerChangesCommand } from './changes.js';
import { registerUriHandler } from './openUri.js';
import { boardLog, disposeChannels } from './logging.js';
import { resolveStateDir } from '@ground-control/core';
import type { Snapshot } from '@ground-control/core';
import { STATE_DIRECTORY_KEY, reconcileStateDirectory, recoverStateDirectory } from './stateDirectory.js';

/** Expose read-only snapshot, render, and log status to other extensions and integration tests. */
export interface GroundControl {
  snapshot(): Snapshot | undefined;
  drew(): Drawn | null;
  /** Whether this window is streaming the hub's log, and how many of its lines have arrived. */
  logs(): { streaming: boolean; lines: number };
}

export function activate(context: vscode.ExtensionContext): GroundControl {
  // Commands, restored boards, and URIs can activate the extension (PRD R26). Installation alone does not activate it.
  const home = homedir();
  const version = String((context.extension.packageJSON as { version?: unknown }).version ?? '0.0.0');

  boardLog().info(`Ground Control ${version} activating with home ${home}`);
  recoverStateDirectory(home);
  migrateLaneMemory(context.globalState, resolveStateDir(home).stateDir);

  const bundle = bundlePathOf(home);

  try {
    writeBundle(home, context.extensionPath, version, bundle);
  } catch (error) {
    // Keep commands and settings available if bundle installation fails; an existing hub bundle may still
    // start.
    boardLog().error(`could not write the hub to ${bundle}: ${String(error)}`);
    void vscode.window.showErrorMessage(`Could not write the hub bundle to ${bundle}: ${String(error)}`);
  }

  // Connect on activation so settings apply without an open board (R34). Poll only while a board is watching
  // (R35).
  const client = startClient(home, bundle);

  client.configure(readHubConfig(userDirOf(context)));
  void reconcileStateDirectory(home, client, true);

  context.subscriptions.push(
    // Apply settings with or without a board and report the resulting hook installation status.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SECTION}.${STATE_DIRECTORY_KEY}`)) {
        void reconcileStateDirectory(home, client);
      }

      if (event.affectsConfiguration(SECTION)) {
        client.configure(readHubConfig(userDirOf(context)), true);
      }
    }),
    vscode.commands.registerCommand('groundControl.openBoard', () => {
      BoardPanel.show(context);
    }),
    // Allow toggling the hub log after its board closes.
    vscode.commands.registerCommand('groundControl.toggleHubLog', () => {
      client.toggleHubLog();
    }),
    // No toggle: this channel is written whether or not anybody is looking, so there is nothing here to turn off.
    vscode.commands.registerCommand('groundControl.showBoardLog', () => {
      boardLog().show(true);
    }),
    vscode.commands.registerCommand('groundControl.refresh', () => {
      // Request an explicit refresh even when opening the board, bypassing the normal source refresh floor.
      BoardPanel.show(context).refresh();
    }),
    // Let the configuration listener remove hooks and report the result.
    vscode.commands.registerCommand('groundControl.removeSessionHooks', () =>
      vscode.workspace
        .getConfiguration(SECTION)
        .update('installSessionHooks', false, vscode.ConfigurationTarget.Global),
    ),
    ...registerOverlayCommands(context, home, bundle),
    registerChangesCommand(),
    // The browser board's way in. Registered here so a link activates this window whether or not a board is open.
    registerUriHandler(),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        BoardPanel.revive(panel, context);
      },
    }),
    { dispose: () => BoardPanel.current?.dispose() },
    { dispose: disposeClient },
    { dispose: disposeChannels },
  );

  // Expose actual window state for integration tests. Product code does not use these accessors.
  return {
    snapshot: () => client.snapshot,
    drew: () => BoardPanel.current?.drew ?? null,
    logs: () => ({ streaming: client.streamingHubLog, lines: client.hubLines }),
  };
}

export function deactivate(): void {}
