import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { activityNotice, pruneMarkers, syncActivity } from '@ground-control/hub';
import type { ActivityState } from '@ground-control/hub';
import { installSessionHooks } from './config.js';
import { agents } from './registry.js';

/** Written once per extension host, on activation. The board reads it; it does not do the writing itself. */
let current: ActivityState | undefined;

/**
 * The state the board reports. A `busy` run observed another process's lock and settled nothing, so it is retried
 * rather than cached: a lock left by a process that crashed leaves this one showing no phase for anything, with
 * nothing on screen saying why (R25).
 */
export function activityState(): ActivityState {
  return current === undefined || current.plan === 'busy' ? syncActivity(agents, wanted(), homedir()) : current;
}

function wanted(): 'install' | 'remove' {
  return installSessionHooks() ? 'install' : 'remove';
}

/** Puts every agent's activity signal where the setting says it should be, and remembers what was observed. */
export function syncActivitySignals(home = homedir()): ActivityState {
  current = syncActivity(agents, wanted(), home);

  return current;
}

export function pruneActivityMarkers(home = homedir()): void {
  pruneMarkers(agents, home);
}

/** What to tell the developer after they changed the setting: what was observed, never what was intended. */
export function settingChangedMessage(state: ActivityState): string {
  return (
    state.failure?.message ??
    activityNotice({ plan: state.plan, wanted: state.wanted, unreported: 0 }) ??
    `Session activity hooks are already ${state.wanted === 'install' ? 'installed' : 'absent'}.`
  );
}

export function showSettingChanged(state: ActivityState): void {
  void vscode.window.showInformationMessage(settingChangedMessage(state));
}
