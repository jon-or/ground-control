import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { diskReaders, readTextFromDisk, resolveStateDir } from '@ground-control/core';
import type { HubConfig } from '@ground-control/core';
import { defaultConfig, makeRegistries } from '@ground-control/hub';
import { SECTION, readHubConfig } from './config.js';
import type { HubClient } from './hubClient.js';
import { EXPLICIT_KEYS, SETUP_KEY, SETUP_VERSION, gated, setupStateOf, settingsFor, storedConfigChose } from './setupState.js';
import type { SetupChoices } from './setupState.js';

/** Whether the first-run choices are still owed. A migrated install records itself so the check is made once. */
export function setupPending(memento: vscode.Memento): boolean {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  const explicit = EXPLICIT_KEYS.filter((key) => configuration.inspect<unknown>(key)?.globalValue !== undefined);
  const stored = storedConfigChose(readTextFromDisk(`${resolveStateDir(homedir()).stateDir}/config.json`));
  const state = setupStateOf(memento.get<unknown>(SETUP_KEY), explicit, stored);

  if (state === 'migrated') {
    void memento.update(SETUP_KEY, { version: SETUP_VERSION, at: new Date().toISOString() });
  }

  return state === 'pending';
}

/** Send this window's settings, withholding hooks, triage, and automatic actions until setup is complete (R26). Returns whether setup is still pending. */
export function configureHub(client: HubClient, memento: vscode.Memento, userDir: string, acknowledge = false): boolean {
  const config: HubConfig = readHubConfig(userDir);
  const pending = setupPending(memento);

  client.configure(pending ? gated(config) : config, acknowledge);

  return pending;
}

let running: Promise<boolean> | null = null;

/**
 * Ask the three first-run questions once, write the answers as global settings, and record completion. Cancel
 * leaves setup pending; the next board open asks again. Returns whether setup completed.
 */
export function runSetup(memento: vscode.Memento, client: HubClient, userDir: string): Promise<boolean> {
  running ??= ask()
    .then(async (choices) => {
      if (choices === null) {
        return false;
      }

      const configuration = vscode.workspace.getConfiguration(SECTION);

      for (const [key, value] of settingsFor(choices)) {
        await configuration.update(key, value, vscode.ConfigurationTarget.Global);
      }

      await memento.update(SETUP_KEY, { version: SETUP_VERSION, at: new Date().toISOString() });
      configureHub(client, memento, userDir, true);

      return true;
    })
    .finally(() => {
      running = null;
    });

  return running;
}

async function ask(): Promise<SetupChoices | null> {
  const registries = makeRegistries();
  // The registry's defaults are the agents it would read unasked: Claude always, Codex when its home exists (R30).
  const detected = new Set(defaultConfig(registries, diskReaders()).agents.map((agent) => agent.id));
  const agents = await vscode.window.showQuickPick(
    registries.agents.map((agent) => ({
      label: agent.displayName,
      id: agent.id,
      picked: detected.has(agent.id),
      description: detected.has(agent.id) ? 'detected' : 'not detected on this machine',
    })),
    { title: 'Ground Control setup (1 of 3): agents to show', canPickMany: true, ignoreFocusOut: true, placeHolder: 'Sessions from unselected agents are not read.' },
  );

  if (agents === undefined) {
    return null;
  }

  // An empty map means the registry defaults, which is not what deselecting everything asked for.
  if (agents.length === 0) {
    void vscode.window.showWarningMessage('Select at least one agent; Ground Control has nothing to show without one.');

    return null;
  }

  const hooks = await vscode.window.showQuickPick(
    [
      { label: 'Install session hooks', detail: 'Adds Ground Control entries to each selected agent\'s settings, with backups, so live sessions report their state.', value: true },
      { label: 'Do not install hooks', detail: 'Sessions are still found by polling; live phase and attention arrive later or not at all.', value: false },
    ],
    { title: 'Ground Control setup (2 of 3): session hooks', ignoreFocusOut: true },
  );

  if (hooks === undefined) {
    return null;
  }

  const triage = await vscode.window.showQuickPick(
    [
      { label: 'Manual', detail: 'Classify a card only when you ask. No model calls otherwise.', value: 'manual' as const },
      { label: 'Automatic', detail: 'Classify eligible cards while a board is visible, within the daily limit. Uses your Claude allowance.', value: 'automatic' as const },
      { label: 'Off', detail: 'No classification controls or requests.', value: 'off' as const },
    ],
    { title: 'Ground Control setup (3 of 3): triage', ignoreFocusOut: true },
  );

  if (triage === undefined) {
    return null;
  }

  return { agents: agents.map((choice) => choice.id), hooks: hooks.value, triage: triage.value };
}
