import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { boardStatuses, statusLanes } from '@ground-control/board';
import { VSCODE_HOST_ID } from '@ground-control/host-vscode';
import { GITHUB_SOURCE_ID } from '@ground-control/github';
import type { CardSource, GithubConfig } from '@ground-control/github';
import { AUTOMATABLE_ACTIONS, diskReaders, idsFrom } from '@ground-control/core';
import type { ActionSetting, AgentConfig, AutomatableAction, HubConfig } from '@ground-control/core';
import { defaultConfig, makeRegistries } from '@ground-control/hub';
import { readSessionScope } from './sessionScope.js';
import { editorAgentHomes } from './agentStorage.js';

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
    repo: cfg.get<string>('github.repo', ''),
    logins: splitLogins(cfg.get<string>(LOGINS, '')),
    projectNumber: cfg.get<number>('github.projectNumber', 3),
    cardSource: cfg.get<CardSource>('cardSource', 'project'),
    maxPages: 5,
  };
}

/** Send the full configuration so omitted fields cannot retain values from a previous client. */
export function readHubConfig(userDir: string): HubConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const configured = cfg.get<Record<string, string>>('agents', {});
  const defaults = defaultConfig(makeRegistries(), diskReaders());

  // An empty agent map uses registry defaults; disabled adapters require explicit configuration (R30).
  const agents: AgentConfig[] =
    Object.keys(configured).length > 0
      ? Object.entries(configured).map(([id, path]) => ({ id, path }))
      : defaults.agents;

  return {
    ...defaults,
    agents,
    agentHomes: editorAgentHomes(),
    branchIssuePattern: cfg.get<string>('branchIssuePattern', '^(\\d+)-'),
    hosts: Object.fromEntries(hostIds().map((id) => [id, id === VSCODE_HOST_ID ? vscodeSettings(userDir) : {}])),
    sources: Object.fromEntries(sourceIds().map((id) => [id, id === GITHUB_SOURCE_ID ? readConfig() : {}])),
    boardStatuses: readBoardStatuses(),
    statusLanes: statusLanes(cfg.get<unknown>('statusLanes')),
    refreshIntervalMs: refreshIntervalMs(),
    sessionIntervalMs: sessionIntervalMs(),
    logLevel: cfg.get<string>('logLevel', 'info') === 'debug' ? 'debug' : 'info',
    installActivity: installSessionHooks(),
    sessionHooks: {
      claude: cfg.get<boolean>('sessionHooks.claude', true),
      codex: cfg.get<boolean>('sessionHooks.codex', true),
    },
    sessionScope: readSessionScope(),
    triage: readTriage(),
    actions: readActions(),
    newSession: { prompt: cfg.get<string>('newSession.prompt', '') },
  };
}

/**
 * Use flat enabled/prompt settings so VS Code renders editable controls (mechanics M50). An empty prompt
 * disables automatic dispatch. Prompts are supplied by the developer because repository workflows differ
 * (R39).
 */
export function readActions(): HubConfig['actions'] {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const number = (key: string, fallback: number): number => {
    const value = cfg.get<number>(key, fallback);

    return Number.isFinite(value) ? Number(value) : fallback;
  };

  // Read the declared flat settings keys directly instead of the synthesized actions.<action> object.
  const setting = (action: AutomatableAction): ActionSetting => {
    const prompt = cfg.get<unknown>(`actions.${action}.prompt`, '');

    return {
      enabled: cfg.get<unknown>(`actions.${action}.enabled`, false) === true,
      prompt: typeof prompt === 'string' ? prompt.trim() : '',
    };
  };

  return {
    agent: cfg.get<NonNullable<HubConfig['actions']['agent']>>('actions.agent', 'auto'),
    model: cfg.get<string>('actions.model', ''),
    permissionMode: cfg.get<string>('actions.permissionMode', 'auto'),
    concurrency: number('actions.concurrency', 1),
    dailyLimit: number('actions.dailyLimit', 10),
    // Minutes in settings, milliseconds in the hub, the way every other interval here is.
    resultTimeoutMs: number('actions.resultMinutes', 30) * 60 * 1000,
    // Omit empty prompts so the board does not offer actions that can only refuse.
    actions: Object.fromEntries(
      AUTOMATABLE_ACTIONS.map((action) => [action, setting(action)] as const).filter(([, held]) => held.prompt !== ''),
    ),
  };
}

/** Use flat keys so all triage limits are editable in the settings UI (R34, R38). */
export function readTriage(): HubConfig['triage'] {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const number = (key: string, fallback: number): number => {
    const value = cfg.get<number>(key, fallback);

    return Number.isFinite(value) ? Number(value) : fallback;
  };

  const explicitMode = cfg.inspect<NonNullable<HubConfig['triage']['mode']>>('triage.mode')?.globalValue;
  const legacy = cfg.inspect<boolean>('triage.enabled')?.globalValue;
  const mode = explicitMode ?? (legacy === undefined ? 'manual' : legacy ? 'automatic' : 'off');

  return {
    enabled: mode !== 'off',
    model: cfg.get<string>('triage.model', ''),
    mode,
    dailyLimit: number('triage.dailyLimit', 100),
    concurrency: number('triage.concurrency', 2),
    // Seconds in settings, milliseconds in the hub, the way every other interval here is.
    timeoutMs: number('triage.timeoutSeconds', 180) * 1000,
    // Discard non-string names before sending configuration; one invalid entry would cause the hub to reject
    // all triage settings.
    names: Object.fromEntries(
      Object.entries(cfg.get<Record<string, unknown>>('triage.names', {}) ?? {}).flatMap(([login, name]) =>
        typeof name === 'string' && name.trim() !== '' ? [[login, name.trim()] as const] : [],
      ),
    ),
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

/** Disabling session hooks removes existing hooks; skipping installation would leave them active (R34). */
export function installSessionHooks(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<boolean>('installSessionHooks', true);
}

/** Control cross-window opening; disabled requests return a named refusal without changing focus (R27). */
export function mayOpenWindow(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<boolean>('openWindowsForSessions', true);
}

/**
 * Derive User from globalStorageUri so portable and Insiders installs read their own state instead of the
 * default install.
 */
export function userDirOf(context: vscode.ExtensionContext): string {
  return dirname(dirname(context.globalStorageUri.fsPath));
}

/** Send configured host and source IDs, including unknown ones, so the hub can report unsupported IDs (R25). */
export function hostIds(): string[] {
  return idsFrom(vscode.workspace.getConfiguration(SECTION).get<unknown>('hosts'), [VSCODE_HOST_ID]);
}

export function sourceIds(): string[] {
  return idsFrom(vscode.workspace.getConfiguration(SECTION).get<unknown>('sources'), [GITHUB_SOURCE_ID]);
}

function vscodeSettings(userDir: string): Record<string, unknown> {
  return { userDir, mayOpenWindow: mayOpenWindow() };
}

/** Write application-scoped settings globally; VS Code rejects workspace overrides for shared board state (R9). */
export async function saveLogins(logins: string[]): Promise<void> {
  await vscode.workspace
    .getConfiguration(SECTION)
    .update(LOGINS, logins.join(','), vscode.ConfigurationTarget.Global);
}
