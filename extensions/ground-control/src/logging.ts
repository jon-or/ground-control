import * as vscode from 'vscode';
import { formatLogLine } from '@ground-control/core';
import type { LogEntry } from '@ground-control/core';

let boardChannel: vscode.LogOutputChannel | undefined;
let hubChannel: vscode.OutputChannel | undefined;

/**
 * Latched on the way out, and never cleared: the extension host does not activate twice. Without it a write that
 * settles after deactivation — an action still in flight when the extension is disabled — builds a channel back
 * that nothing is left to dispose, and the developer keeps an orphan entry in the Output picker.
 */
let gone = false;

/** A channel that is not there any more, for the writes that arrive after everything has been torn down. */
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
 * What this window is doing, in VS Code's own log channel: it stamps and levels every line, and the editor's log
 * level picker filters it. Written whether or not anybody is looking — this half of the story never leaves the
 * process that wrote it, so there is nothing here to hold back until a viewer opens (R40).
 */
export function boardLog(): Pick<vscode.LogOutputChannel, 'debug' | 'info' | 'warn' | 'error' | 'show'> {
  if (gone) {
    return NOWHERE;
  }

  boardChannel ??= vscode.window.createOutputChannel('Ground Control', { log: true });

  return boardChannel;
}

/**
 * What the hub is doing, in the format `hub.log` itself holds. A plain channel and not a `LogOutputChannel`,
 * because those stamp each line with the moment it arrived: the tail a viewer opens with was written minutes or
 * hours ago, and restamping it would date a crash to the moment the developer went looking for it.
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
    // A line no logger wrote — a crash, or a banner the spawn's stdout carried — reaches here as `raw`, holding the
    // timestamp of the line above it. Written as itself: a stack trace given a timestamp it never had reads as one.
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
