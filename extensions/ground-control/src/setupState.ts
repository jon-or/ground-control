import type { HubConfig } from '@ground-control/core';

/** Memento key holding the first-run record. */
export const SETUP_KEY = 'setup';
export const SETUP_VERSION = 1;

/** Settings whose explicit global value proves the developer already chose; their presence migrates an older install. */
export const EXPLICIT_KEYS = ['agents', 'installSessionHooks', 'sessionHooks.claude', 'sessionHooks.codex', 'triage.mode', 'triage.enabled'] as const;

export type SetupState = 'done' | 'migrated' | 'pending';

/**
 * Done when the record exists; migrated when an explicit choice or a hub configuration stored with hooks on
 * predates the record; pending on a fresh install, where hooks and model calls wait for the developer.
 */
export function setupStateOf(record: unknown, explicitKeys: readonly string[], storedChose: boolean): SetupState {
  if (typeof record === 'object' && record !== null && (record as { version?: unknown }).version === SETUP_VERSION) {
    return 'done';
  }

  return explicitKeys.length > 0 || storedChose ? 'migrated' : 'pending';
}

/** A stored configuration proves a choice only when it has hooks on; the gated configuration this version stores does not. */
export function storedConfigChose(text: string | null): boolean {
  if (text === null) {
    return false;
  }

  try {
    return (JSON.parse(text) as { installActivity?: unknown }).installActivity === true;
  } catch {
    return false;
  }
}

/** Session discovery and GitHub reads continue; hook writes, classification, and automatic actions wait for the choice (R26). */
export function gated(config: HubConfig): HubConfig {
  return {
    ...config,
    installActivity: false,
    triage: { ...config.triage, enabled: false, mode: 'off' },
    actions: { ...config.actions, actions: {} },
  };
}

export interface SetupChoices {
  agents: string[];
  hooks: boolean;
  triage: 'manual' | 'automatic' | 'off';
}

/** The settings writes one round of choices produces. Agent values are command names; paths can be edited later. */
export function settingsFor(choices: SetupChoices): [string, unknown][] {
  return [
    ['agents', Object.fromEntries(choices.agents.map((id) => [id, id]))],
    ['installSessionHooks', choices.hooks],
    ['triage.mode', choices.triage],
  ];
}
