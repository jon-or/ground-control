import { describe, expect, it } from 'vitest';
import { DEFAULT_BOARD_STATUSES, DEFAULT_STATUS_LANES } from '@ground-control/board';
import { CLAUDE_AGENT_ID } from '@ground-control/agent-claude';
import { CODEX_AGENT_ID } from '@ground-control/agent-codex';
import { VSCODE_HOST_ID } from '@ground-control/host-vscode';
import { GITHUB_SOURCE_ID } from '@ground-control/github';
import type { BoardPolicy, WorkSource } from '@ground-control/core';
import { configureHosts, configureSources, defaultConfig, makeRegistries } from '../src/registry.js';
import { fakeAgent, fakeReaders } from './helpers.js';

describe('the registries', () => {
  it('carry both agents, the host, and the source that ship', () => {
    const registries = makeRegistries();

    expect(registries.agents.map((a) => a.id)).toEqual([CLAUDE_AGENT_ID, CODEX_AGENT_ID]);
    expect(registries.hosts.map((h) => h.id)).toEqual([VSCODE_HOST_ID]);
    expect(registries.sources.map((s) => s.id)).toEqual([GITHUB_SOURCE_ID]);
  });

  it('give every registered target a distinct id and a default command', () => {
    const { agents, hosts, sources } = makeRegistries();

    expect(new Set(agents.map((a) => a.id)).size).toBe(agents.length);
    expect(new Set(hosts.map((h) => h.id)).size).toBe(hosts.length);
    expect(new Set(sources.map((s) => s.id)).size).toBe(sources.length);
    expect(agents.every((a) => a.id.length > 0 && a.defaultPath.length > 0)).toBe(true);
  });
});

describe('defaultConfig', () => {
  it('uses default agent commands and board settings', () => {
    const config = defaultConfig(makeRegistries(), fakeReaders());

    expect(config.agents).toEqual([{ id: CLAUDE_AGENT_ID, path: 'claude' }]);
    expect(config.boardStatuses).toEqual([...DEFAULT_BOARD_STATUSES]);
    expect(config.statusLanes).toEqual({ ...DEFAULT_STATUS_LANES });
    expect(config.hosts).toEqual({ [VSCODE_HOST_ID]: {} });
    expect(config.sources).toEqual({ [GITHUB_SOURCE_ID]: {} });
  });

  /** Detect installed Codex without explicit agent settings (R30). */
  it('detects Codex when its home exists', () => {
    const registries = makeRegistries();
    const readers = fakeReaders({ '/home/dev/.codex': ['config.toml'] });

    expect(defaultConfig(registries, readers).agents).toEqual([
      { id: CLAUDE_AGENT_ID, path: 'claude' },
      { id: CODEX_AGENT_ID, path: 'codex' },
    ]);
  });

  /** R30: a CLI the machine does not have must not produce a "not found" notice on every refresh. */
  it('enables only the agents the machine has', () => {
    const registries = {
      agents: [fakeAgent('on'), { ...fakeAgent('off'), enabledByDefault: () => false }],
      hosts: [],
      sources: [],
    };

    expect(defaultConfig(registries, fakeReaders()).agents.map((a) => a.id)).toEqual(['on']);
  });

  it('polls the two sources at the cadence each of them costs', () => {
    const config = defaultConfig(makeRegistries(), fakeReaders());

    expect(config.sessionIntervalMs).toBeLessThan(config.refreshIntervalMs);
    expect(config.sessionIntervalMs).toBeGreaterThan(0);
  });

  /** A hub the browser started alone has heard from no client, so these are what it polls with. */
  it('supports empty configuration', () => {
    const config = defaultConfig(makeRegistries(), fakeReaders());

    expect(config.branchIssuePattern).toBe('^(\\d+)-');
    expect(config.installActivity).toBe(true);
  });
});

describe('configureHosts', () => {
  it('accepts valid host settings', () => {
    expect(configureHosts(makeRegistries(), { [VSCODE_HOST_ID]: { mayOpenWindow: false } })).toEqual([]);
  });

  it('reports unknown host IDs', () => {
    const failures = configureHosts(makeRegistries(), { intellij: {} });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ subject: 'intellij', kind: 'unknown-host' });
    expect(failures[0]?.remedy).toContain('groundControl.hosts');
  });

  it('preserves host validation failures', () => {
    const failures = configureHosts(makeRegistries(), { [VSCODE_HOST_ID]: { mayOpenWindow: 'yes' } });

    expect(failures[0]).toMatchObject({ subject: VSCODE_HOST_ID, kind: 'bad-config' });
  });

  it('reports every id that is wrong, not the first', () => {
    const failures = configureHosts(makeRegistries(), { intellij: {}, emacs: {} });

    expect(failures.map((f) => f.subject)).toEqual(['intellij', 'emacs']);
  });
});

describe('configureSources', () => {
  it('accepts valid source settings', () => {
    expect(configureSources(makeRegistries(), { [GITHUB_SOURCE_ID]: { repo: 'example-org/example-repo' } })).toEqual([]);
  });

  it('hands every source the board policy', () => {
    const given: unknown[] = [];
    const fake: WorkSource = { id: 'fake', displayName: 'Fake', configure: (_raw: unknown, board?: BoardPolicy) => { given.push(board); return null; }, read: () => Promise.resolve({ items: null, failure: null, needs: null }) };

    configureSources({ ...makeRegistries(), sources: [fake] }, { fake: {} }, { reviewStatuses: ['QA'], avatar: { review: 'assignee', offReview: 'issue-author' } });

    expect(given).toEqual([{ reviewStatuses: ['QA'], avatar: { review: 'assignee', offReview: 'issue-author' } }]);
  });

  it('reports unknown source IDs', () => {
    const failures = configureSources(makeRegistries(), { jira: {} });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ subject: 'jira', kind: 'unknown-source' });
    expect(failures[0]?.remedy).toContain('groundControl.sources');
  });

  it('preserves source validation failures', () => {
    const failures = configureSources(makeRegistries(), { [GITHUB_SOURCE_ID]: { repo: '' } });

    expect(failures[0]).toMatchObject({ subject: GITHUB_SOURCE_ID, kind: 'bad-config' });
  });
});
