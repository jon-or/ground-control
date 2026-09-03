import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { boardStatuses, statusLanes } from '@ground-control/board';
import { VSCODE_HOST_ID } from '@ground-control/host-vscode';
import type { CardSource, GithubConfig } from '@ground-control/github';
import type { AgentConfig, HubConfig } from '@ground-control/core';
import { defaultConfig } from '@ground-control/hub';

export const SECTION = 'groundControl';
const LOGINS = 'github.logins';

export function splitLogins(value: string): string[] {
  return value
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function readConfig(): GithubConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);

  return {
    ghPath: cfg.get<string>('github.ghPath', 'gh'),
    repo: cfg.get<string>('github.repo', 'ownerrez/orez'),
    logins: splitLogins(cfg.get<string>(LOGINS, '')),
    projectNumber: cfg.get<number>('github.projectNumber', 3),
    cardSource: cfg.get<CardSource>('cardSource', 'project'),
    maxPages: 5,
  };
}

/**
 * Everything this window's settings say, as the hub takes it. Pushed whole rather than field by field: the hub
 * merges one of these over its own defaults, and a client that sent half a configuration would leave the other half
 * at whatever the last client set.
 */
export function readHubConfig(hosts: Record<string, unknown> = {}): HubConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const configured = cfg.get<Record<string, string>>('agents', {});
  const defaults = defaultConfig();

  // R30: only the CLIs named here are read. An empty map means the defaults, so an adapter that ships enabled works
  // without the developer editing settings, and one that ships off stays off until they name it.
  const agents: AgentConfig[] =
    Object.keys(configured).length > 0
      ? Object.entries(configured).map(([id, path]) => ({ id, path }))
      : defaults.agents;

  return {
    ...defaults,
    agents,
    branchIssuePattern: cfg.get<string>('branchIssuePattern', '^(\\d+)-'),
    hosts,
    sources: { github: readConfig() },
    boardStatuses: readBoardStatuses(),
    statusLanes: statusLanes(cfg.get<unknown>('statusLanes')),
    refreshIntervalMs: refreshIntervalMs(),
    sessionIntervalMs: sessionIntervalMs(),
    installActivity: installSessionHooks(),
  };
}

export function readBoardStatuses(): string[] {
  return boardStatuses(vscode.workspace.getConfiguration(SECTION).get<unknown>('boardStatuses'));
}

/** A hand-edited settings.json can hold a string here, and setInterval(NaN) fires every millisecond. */
function intervalMs(key: string, fallback: number, floor: number): number {
  const seconds = vscode.workspace.getConfiguration(SECTION).get<number>(key, fallback);

  return (Number.isFinite(seconds) ? Math.max(floor, Number(seconds)) : fallback) * 1000;
}

export function refreshIntervalMs(): number {
  return intervalMs('refreshIntervalSeconds', 300, 30);
}

export function sessionIntervalMs(): number {
  return intervalMs('sessionRefreshSeconds', 30, 2);
}

/**
 * R34: whether the board may put its activity hooks in the developer's own Claude Code settings. Off removes them —
 * skipping the install instead would leave the hooks the board already wrote running forever.
 */
export function installSessionHooks(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<boolean>('installSessionHooks', true);
}

/**
 * R27: whether the board may bring another window forward. Off, a session held in another window is refused by name
 * rather than reached by moving the developer's focus.
 */
export function mayOpenWindow(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<boolean>('openWindowsForSessions', true);
}

/**
 * Where this VS Code keeps its state. `globalStorageUri` is `<user>/User/globalStorage/<extension>`, so the `User`
 * directory two levels above it is the one the running install writes to — assuming the default location would read
 * another install's windows on a portable or Insiders one.
 */
export function userDirOf(context: vscode.ExtensionContext): string {
  return dirname(dirname(context.globalStorageUri.fsPath));
}

/**
 * The `vscode` host's settings, under the id the hub knows the host by. Keyed here rather than at each call site: a
 * caller that passed the settings object itself would have every field in it read as a host id.
 */
export function vscodeSettings(userDir: string): Record<string, unknown> {
  return { [VSCODE_HOST_ID]: { userDir, mayOpenWindow: mayOpenWindow() } };
}

/**
 * Global, because every setting the hub reads is application-scoped: one board's memory is shared by every window
 * (R9), so VS Code refuses a workspace override and writing to one would be a value nothing ever reads.
 */
export async function saveLogins(logins: string[]): Promise<void> {
  await vscode.workspace
    .getConfiguration(SECTION)
    .update(LOGINS, logins.join(','), vscode.ConfigurationTarget.Global);
}
