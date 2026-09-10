import { describe, expect, it } from 'vitest';
import type { HubConfig } from '@ground-control/core';
import { EXPLICIT_KEYS, SETUP_VERSION, gated, settingsFor, setupStateOf, storedConfigChose } from '../src/setupState.js';

describe('whether the first-run choices are still owed', () => {
  it('is pending on a fresh install, with no record, no explicit setting, and no stored hub configuration', () => {
    expect(setupStateOf(undefined, [], false)).toBe('pending');
  });

  /** An install that already chose, by hand or by running an older version, is not asked again. */
  it('migrates an install that already chose, in settings or through a stored configuration', () => {
    expect(setupStateOf(undefined, ['agents'], false)).toBe('migrated');
    expect(setupStateOf(undefined, [], true)).toBe('migrated');
  });

  it('is done once the record of this version exists, and pending again for an older record', () => {
    expect(setupStateOf({ version: SETUP_VERSION, at: '2026-09-09T00:00:00Z' }, [], false)).toBe('done');
    expect(setupStateOf({ version: 0 }, [], false)).toBe('pending');
    expect(setupStateOf('done', [], false)).toBe('pending');
  });

  /** The gated configuration this version stores must not read as a choice, or a cancelled setup would complete itself. */
  it('takes a stored configuration as a choice only when it has hooks on', () => {
    expect(storedConfigChose(JSON.stringify({ installActivity: true }))).toBe(true);
    expect(storedConfigChose(JSON.stringify({ installActivity: false, triage: { mode: 'off' } }))).toBe(false);
    expect(storedConfigChose('{ not json')).toBe(false);
    expect(storedConfigChose(null)).toBe(false);
  });

  it('names every setting whose explicit value counts as a choice', () => {
    expect([...EXPLICIT_KEYS]).toEqual(['agents', 'installSessionHooks', 'sessionHooks.claude', 'sessionHooks.codex', 'triage.mode', 'triage.enabled']);
  });
});

describe('what the hub receives before the choices are made', () => {
  const config = {
    installActivity: true,
    triage: { enabled: true, mode: 'automatic' },
    actions: { agent: 'auto', actions: { 'merge-upstream': { enabled: true, prompt: 'merge' } } },
    agents: [{ id: 'claude', path: 'claude' }],
  } as unknown as HubConfig;

  /** Session discovery keeps working; hook writes, model calls, and automatic actions wait (R26). */
  it('turns hooks, triage, and automatic actions off and leaves the agents alone', () => {
    const held = gated(config);

    expect(held.installActivity).toBe(false);
    expect(held.triage).toMatchObject({ enabled: false, mode: 'off' });
    expect(held.actions).toMatchObject({ agent: 'auto', actions: {} });
    expect(held.agents).toEqual(config.agents);
  });
});

describe('the settings one round of choices writes', () => {
  it('maps agents to their command names and records hooks and triage as chosen', () => {
    expect(settingsFor({ agents: ['claude', 'codex'], hooks: false, triage: 'manual' })).toEqual([
      ['agents', { claude: 'claude', codex: 'codex' }],
      ['installSessionHooks', false],
      ['triage.mode', 'manual'],
    ]);
  });
});
