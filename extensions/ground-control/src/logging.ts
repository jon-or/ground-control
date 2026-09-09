import * as vscode from 'vscode';
import { formatLogLine } from '@ground-control/core';
import type { LogEntry } from '@ground-control/core';

let boardChannel: vscode.LogOutputChannel | undefined;
let hubChannel: vscode.OutputChannel | undefined;

/** Prevent delayed writes from recreating output channels after deactivation, when no disposer remains. */
let gone = false;

/** Ignore writes after channels are disposed. */
const NOWHERE = {
  appendLine: () => {},
  show: () => {},
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Use a local LogOutputChannel for timestamps and editor log-level filtering. Write regardless of viewer
 * presence (R40).
 */
export function boardLog(): Pick<vscode.LogOutputChannel, 'debug' | 'info' | 'warn' | 'error' | 'show'> {
  if (gone) {
    return NOWHERE;
  }

  boardChannel ??= vscode.window.createOutputChannel('Ground Control', { log: true });

  return boardChannel;
}

/**
 * Use a plain output channel to preserve original hub timestamps; LogOutputChannel would timestamp backfilled
 * lines at receipt.
 */
export function hubLog(): Pick<vscode.OutputChannel, 'appendLine' | 'show'> {
  if (gone) {
    return NOWHERE;
  }

  hubChannel ??= vscode.window.createOutputChannel('Ground Control Hub');

  return hubChannel;
}

/** The hub's own lines, verbatim. Only ever reached by a client that asked the hub to send them. */
export function showHubEntries(entries: readonly LogEntry[]): void {
  const channel = hubLog();

  for (const entry of entries) {
    // Preserve raw crash output and banners without adding the inherited timestamp.
    channel.appendLine(entry.scope === 'raw' ? entry.message : formatLogLine(entry));
  }
}

export function disposeChannels(): void {
  gone = true;
  boardChannel?.dispose();
  hubChannel?.dispose();
  boardChannel = undefined;
  hubChannel = undefined;
}
