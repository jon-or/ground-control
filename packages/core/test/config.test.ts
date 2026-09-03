import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHubConfig } from '../src/config.js';
import type { HubConfig } from '../src/config.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gc-config-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function config(over: Partial<HubConfig> = {}): Record<string, unknown> {
  return {
    agents: [{ id: 'claude', path: 'claude' }],
    branchIssuePattern: '^(\\d+)-',
    hosts: { vscode: {} },
    sources: { github: { repo: 'example-org/example-repo' } },
    boardStatuses: ['⚒️ Dev'],
    statusLanes: { '🔍 Dev Review': 'review' },
    refreshIntervalMs: 300_000,
    sessionIntervalMs: 30_000,
    installActivity: true,
    ...over,
  };
}

function accepted(raw: unknown): HubConfig {
  const parsed = parseHubConfig(raw);

  if ('failure' in parsed) {
    throw new Error(`expected this to be accepted: ${parsed.failure.message}`);
  }

  return parsed.config;
}

function refusal(raw: unknown): string {
  const parsed = parseHubConfig(raw);

  if (!('failure' in parsed)) {
    throw new Error('expected this to be refused');
  }

  expect(parsed.failure.kind).toBe('bad-config');

  return parsed.failure.message;
}

describe('the path a client asks the hub to spawn', () => {
  /** A bare name is resolved against `PATH` at spawn time, so there is nothing to check for on disk. */
  it('takes a command name', () => {
    expect(accepted(config()).agents).toEqual([{ id: 'claude', path: 'claude' }]);
  });

  it('takes a path to a file that is there', () => {
    const path = `${dir}/claude.cmd`;
    writeFileSync(path, '');

    expect(accepted(config({ agents: [{ id: 'claude', path }] })).agents[0]?.path).toBe(path);
  });

  /**
   * The one field of a pushed configuration that becomes a process. A client is not necessarily this editor, so a
   * path naming nothing is refused rather than spawned and reported as a missing CLI.
   */
  it('refuses a path to nothing, and says which field it was', () => {
    expect(refusal(config({ agents: [{ id: 'claude', path: `${dir}/not-here.exe` }] }))).toContain('agents.0.path');
  });

  it('refuses a path in either separator, so a Windows one is not waved through', () => {
    expect(refusal(config({ agents: [{ id: 'claude', path: 'c:\\nope\\claude.exe' }] }))).toContain('agents.0.path');
    expect(refusal(config({ agents: [{ id: 'claude', path: './nope/claude' }] }))).toContain('agents.0.path');
  });

  it('refuses an empty path and an unnamed agent', () => {
    expect(refusal(config({ agents: [{ id: 'claude', path: '' }] }))).toContain('agents.0.path');
    expect(refusal(config({ agents: [{ id: '', path: 'claude' }] }))).toContain('agents.0.id');
  });
});

describe('the cadences', () => {
  /** A hand-edited settings file can ask for a zero-second poll, which is a spin on a CLI spawn. */
  it('lifts a poll under the floor up to it', () => {
    const lifted = accepted(config({ refreshIntervalMs: 0, sessionIntervalMs: 0 }));

    expect(lifted.refreshIntervalMs).toBe(30_000);
    expect(lifted.sessionIntervalMs).toBe(2_000);
  });

  it('leaves a poll above the floor alone, so the floor is not a fixed value', () => {
    const kept = accepted(config({ refreshIntervalMs: 900_000, sessionIntervalMs: 45_000 }));

    expect(kept.refreshIntervalMs).toBe(900_000);
    expect(kept.sessionIntervalMs).toBe(45_000);
  });

  it('refuses a cadence that is not a number the clock can use', () => {
    expect(refusal(config({ refreshIntervalMs: Number.NaN }))).toContain('refreshIntervalMs');
    expect(refusal(config({ sessionIntervalMs: Number.POSITIVE_INFINITY }))).toContain('sessionIntervalMs');
  });
});

describe('the rest of a pushed configuration', () => {
  it('refuses a lane no board has', () => {
    expect(refusal(config({ statusLanes: { '🔍 Dev Review': 'nowhere' } as never }))).toContain('statusLanes');
  });

  it('refuses a configuration missing a key the hub polls with', () => {
    const { boardStatuses, ...missing } = config();

    expect(refusal(missing)).toContain('boardStatuses');
  });

  it('refuses something that is not a configuration at all', () => {
    expect(refusal(null)).toContain('could not be read');
    expect(refusal('{}')).toContain('could not be read');
  });

  /** Host and source entries belong to the adapter that owns the id, so nothing here judges their shape. */
  it('carries host and source entries through without reading them', () => {
    const carried = accepted(config({ hosts: { vscode: { userDir: 'd:/anything' } }, sources: { anything: 42 } }));

    expect(carried.hosts).toEqual({ vscode: { userDir: 'd:/anything' } });
    expect(carried.sources).toEqual({ anything: 42 });
  });
});
