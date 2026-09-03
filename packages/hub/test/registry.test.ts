import { describe, expect, it } from 'vitest';
import { DEFAULT_BOARD_STATUSES, DEFAULT_STATUS_LANES } from '@ground-control/board';
import { CLAUDE_AGENT_ID } from '@ground-control/agent-claude';
import { VSCODE_HOST_ID } from '@ground-control/host-vscode';
import { configureHosts, defaultConfig, makeRegistries } from '../src/registry.js';
import { fakeAgent } from './helpers.js';

describe('the registries', () => {
  it('carry the agent and the host that ship', () => {
    const registries = makeRegistries();

    expect(registries.agents.map((a) => a.id)).toEqual([CLAUDE_AGENT_ID]);
    expect(registries.hosts.map((h) => h.id)).toEqual([VSCODE_HOST_ID]);
  });

  it('give every registered target a distinct id and a default command', () => {
    const { agents, hosts } = makeRegistries();

    expect(new Set(agents.map((a) => a.id)).size).toBe(agents.length);
    expect(new Set(hosts.map((h) => h.id)).size).toBe(hosts.length);
    expect(agents.every((a) => a.id.length > 0 && a.defaultPath.length > 0)).toBe(true);
  });
});

describe('defaultConfig', () => {
  it('polls the shipped agent at its own command, with the shipped statuses and lanes', () => {
    const config = defaultConfig();

    expect(config.agents).toEqual([{ id: CLAUDE_AGENT_ID, path: 'claude' }]);
    expect(config.boardStatuses).toEqual([...DEFAULT_BOARD_STATUSES]);
    expect(config.statusLanes).toEqual({ ...DEFAULT_STATUS_LANES });
    expect(config.hosts).toEqual({ [VSCODE_HOST_ID]: {} });
  });

  /** R30: a CLI that is not the developer's primary agent must not produce a "not found" notice on every refresh. */
  it('enables only the agents that ship enabled', () => {
    const registries = {
      agents: [fakeAgent('on'), { ...fakeAgent('off'), defaultEnabled: false }],
      hosts: [],
    };

    expect(defaultConfig(registries).agents.map((a) => a.id)).toEqual(['on']);
  });

  it('polls the two sources at the cadence each of them costs', () => {
    const config = defaultConfig();

    expect(config.sessionIntervalMs).toBeLessThan(config.refreshIntervalMs);
    expect(config.sessionIntervalMs).toBeGreaterThan(0);
  });

  /** A hub the browser started alone has heard from no client, so these are what it polls with. */
  it('is usable with nothing configured at all', () => {
    const config = defaultConfig();

    expect(config.branchIssuePattern).toBe('^(\\d+)-');
    expect(config.installActivity).toBe(true);
  });
});

describe('configureHosts', () => {
  it('accepts what a registered host accepts, and reports nothing', () => {
    expect(configureHosts(makeRegistries(), { [VSCODE_HOST_ID]: { mayOpenWindow: false } })).toEqual([]);
  });

  it('names an id the registry does not carry, rather than reaching nothing in silence', () => {
    const failures = configureHosts(makeRegistries(), { intellij: {} });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ subject: 'intellij', kind: 'unknown-host' });
    expect(failures[0]?.remedy).toContain('groundControl.hosts');
  });

  it('carries through what the host said was wrong with its own settings', () => {
    const failures = configureHosts(makeRegistries(), { [VSCODE_HOST_ID]: { mayOpenWindow: 'yes' } });

    expect(failures[0]).toMatchObject({ subject: VSCODE_HOST_ID, kind: 'bad-config' });
  });

  it('reports every id that is wrong, not the first', () => {
    const failures = configureHosts(makeRegistries(), { intellij: {}, emacs: {} });

    expect(failures.map((f) => f.subject)).toEqual(['intellij', 'emacs']);
  });
});
