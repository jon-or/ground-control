import * as vscode from 'vscode';
import type { CardSource, GithubConfig } from '@ground-control/github';

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

export function refreshIntervalMs(): number {
  const seconds = vscode.workspace.getConfiguration(SECTION).get<number>('refreshIntervalSeconds', 300);

  // A hand-edited settings.json can hold a string here, and setInterval(NaN) fires every millisecond.
  return (Number.isFinite(seconds) ? Math.max(30, Number(seconds)) : 300) * 1000;
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
