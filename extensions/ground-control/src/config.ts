import * as vscode from 'vscode';
import { boardStatuses, statusLanes } from '@ground-control/board';
import type { BoardRules } from '@ground-control/board';
import type { CardSource, GithubConfig } from '@ground-control/github';
import type { AgentConfig, SessionsConfig } from '@ground-control/core';
import { agents } from './registry.js';

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

export function readSessionsConfig(): SessionsConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);

  const configured = cfg.get<Record<string, string>>('agents', {});

  // R30: only the CLIs named here are read. An empty map means the defaults, so an adapter that ships enabled works
  // without the developer editing settings, and one that ships off stays off until they name it.
  const entries: AgentConfig[] =
    Object.keys(configured).length > 0
      ? Object.entries(configured).map(([id, path]) => ({ id, path }))
      : agents.filter((adapter) => adapter.defaultEnabled).map((adapter) => ({ id: adapter.id, path: adapter.defaultPath }));

  return {
    agents: entries,
    branchIssuePattern: cfg.get<string>('branchIssuePattern', '^(\\d+)-'),
  };
}

export function readBoardStatuses(): string[] {
  return boardStatuses(vscode.workspace.getConfiguration(SECTION).get<unknown>('boardStatuses'));
}

/** What a card arriving is judged against. The logins come from the GitHub config, so a PR is only the developer's own by the same name. */
export function readBoardRules(logins: readonly string[]): BoardRules {
  return {
    boardStatuses: readBoardStatuses(),
    statusLanes: statusLanes(vscode.workspace.getConfiguration(SECTION).get<unknown>('statusLanes')),
    logins: [...logins],
  };
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

/** The `vscode` host's own settings. `userDir` is the running install's, which is not the default one on a portable install. */
export function vscodeSettings(userDir: string): Record<string, unknown> {
  return { userDir, mayOpenWindow: mayOpenWindow() };
}

/**
 * Writes to the scope that already carries a value, defaulting to Global. Writing Global unconditionally is
 * invisible when a workspace or folder setting shadows it, and the developer gets asked again every refresh.
 */
export async function saveLogins(logins: string[]): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const scopes = cfg.inspect<string>(LOGINS);

  const target =
    scopes?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : scopes?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

  await cfg.update(LOGINS, logins.join(','), target);
}
