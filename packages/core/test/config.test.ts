import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCommand, idsFrom, parseHubConfig } from '../src/config.js';
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

/** Empty command settings must fall back to the adapter command before constructing attach arguments. */
describe('the command that runs an agent', () => {
  it('takes the path the developer named, and the id where they named none', () => {
    expect(agentCommand({ claude: 'C:/tools/claude.exe' }, 'claude')).toBe('C:/tools/claude.exe');
    expect(agentCommand({}, 'claude')).toBe('claude');
    expect(agentCommand({ codex: 'x' }, 'claude')).toBe('claude');
  });

  it('reads an empty or blank path as none, the way an adapter does', () => {
    expect(agentCommand({ claude: '' }, 'claude')).toBe('claude');
    expect(agentCommand({ claude: '   ' }, 'claude')).toBe('claude');
  });
});

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

  /** Reject nonexistent configured paths before process launch. */
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
    expect(refusal(null)).toContain('Could not read settings:');
    expect(refusal('{}')).toContain('Could not read settings:');
  });

  /** Host and source entries belong to the adapter that owns the id, so nothing here judges their shape. */
  it('carries host and source entries through without reading them', () => {
    const carried = accepted(config({ hosts: { vscode: { userDir: 'd:/anything' } }, sources: { anything: 42 } }));

    expect(carried.hosts).toEqual({ vscode: { userDir: 'd:/anything' } });
    expect(carried.sources).toEqual({ anything: 42 });
  });
});

describe('idsFrom', () => {
  it('names what the list names', () => {
    expect(idsFrom(['vscode', 'intellij'], ['vscode'])).toEqual(['vscode', 'intellij']);
  });

  /** A hand-edited settings file holds whatever was typed, and reading a bare string as a list is a crash. */
  it('falls back to the shipped ids when the value is not a list', () => {
    expect(idsFrom('vscode', ['vscode'])).toEqual(['vscode']);
    expect(idsFrom(undefined, ['github'])).toEqual(['github']);
    expect(idsFrom({ vscode: true }, ['vscode'])).toEqual(['vscode']);
  });

  /** An entry that is not a name would reach the hub as a target it cannot carry, named as `[object Object]`. */
  it('drops an entry that is not a name, and keeps the rest', () => {
    expect(idsFrom(['vscode', 3, null, '', '   ', {}], ['nothing'])).toEqual(['vscode']);
  });

  /** Deliberate, not unreadable: a developer who lists nothing is asking for nothing, and gets the shipped ids never. */
  it('takes an empty list as an empty list', () => {
    expect(idsFrom([], ['vscode'])).toEqual([]);
  });
});

describe('triage settings', () => {
  function triageOf(raw: unknown) {
    const parsed = parseHubConfig(config({ triage: raw } as never));

    return 'config' in parsed ? parsed.config.triage : parsed.failure;
  }

  it('defaults a configuration written before triage existed, rather than refusing it', () => {
    const parsed = parseHubConfig(config());

    expect('config' in parsed && parsed.config.triage).toEqual({ enabled: true, mode: 'manual', dailyLimit: 100, concurrency: 2, timeoutMs: 180_000, names: {} });
  });

  it('takes what a client asked for', () => {
    expect(triageOf({ enabled: false, concurrency: 4, timeoutMs: 90_000, names: { buildfriday: 'Chris' } })).toEqual({
      enabled: false,
      mode: 'off',
      dailyLimit: 100,
      concurrency: 4,
      timeoutMs: 90_000,
      names: { buildfriday: 'Chris' },
    });
  });

  it('reads a names map that is not one as none, rather than costing the whole configuration', () => {
    // Invalid display-name overrides must not invalidate the full configuration.
    expect(triageOf({ enabled: true, concurrency: 2, timeoutMs: 60_000, names: 'buildfriday=Chris' })).toMatchObject({ names: {} });
    expect(triageOf({ enabled: true, concurrency: 2, timeoutMs: 60_000, names: { buildfriday: 7 } })).toMatchObject({ names: {} });
  });

  it('floors and ceilings a hand-edited spend, in both directions', () => {
    expect(triageOf({ enabled: true, concurrency: 0, timeoutMs: 1 })).toEqual({
      enabled: true,
      mode: 'automatic',
      dailyLimit: 100,
      concurrency: 1,
      timeoutMs: 10_000,
      names: {},
    });
    expect(triageOf({ enabled: true, concurrency: 500, timeoutMs: 9_999_999 })).toEqual({
      enabled: true,
      mode: 'automatic',
      dailyLimit: 100,
      concurrency: 8,
      timeoutMs: 300_000,
      names: {},
    });
  });

  it('refuses a triage block that is not one, rather than spending on a default nobody chose', () => {
    expect(triageOf({ enabled: 'yes', concurrency: 2, timeoutMs: 60_000 })).toMatchObject({ kind: 'bad-config' });
    expect(triageOf('on')).toMatchObject({ kind: 'bad-config' });
  });

  it('preserves legacy choices and gives explicit modes precedence', () => {
    const legacy = { enabled: true, concurrency: 2, timeoutMs: 60_000 };
    expect(triageOf(legacy)).toMatchObject({ mode: 'automatic', enabled: true });
    expect(triageOf({ ...legacy, enabled: false })).toMatchObject({ mode: 'off', enabled: false });
    expect(triageOf({ ...legacy, mode: 'off' })).toMatchObject({ mode: 'off', enabled: false });
    expect(triageOf({ ...legacy, enabled: false, mode: 'manual', dailyLimit: 0 })).toMatchObject({ mode: 'manual', enabled: true, dailyLimit: 0 });
    for (const dailyLimit of [-1, 1001, 1.5, '100']) {
      expect(triageOf({ ...legacy, dailyLimit })).toMatchObject({ kind: 'bad-config' });
    }
    expect(triageOf({ ...legacy, mode: 'sometimes' })).toMatchObject({ kind: 'bad-config' });
  });

  it('carries an agent model where one is set, and omits the field where none is', () => {
    const withModel = parseHubConfig(config({ agents: [{ id: 'claude', path: 'claude', model: 'claude-haiku-4-5' }] }));
    const without = parseHubConfig(config());

    expect('config' in withModel && withModel.config.agents[0]).toEqual({
      id: 'claude',
      path: 'claude',
      model: 'claude-haiku-4-5',
    });
    expect('config' in without && without.config.agents[0]).toEqual({ id: 'claude', path: 'claude' });
  });

  it('refuses an empty model rather than spawning with a blank --model', () => {
    expect(parseHubConfig(config({ agents: [{ id: 'claude', path: 'claude', model: '' }] }))).toMatchObject({
      failure: { kind: 'bad-config' },
    });
  });
});

describe('what the board may do on its own', () => {
  function actionsOf(raw: unknown) {
    const parsed = parseHubConfig(config({ actions: raw } as never));

    return 'config' in parsed ? parsed.config.actions : parsed.failure;
  }

  it('defaults a configuration written before the board acted at all to doing nothing', () => {
    const parsed = parseHubConfig(config());

    expect('config' in parsed && parsed.config.actions).toEqual({
      permissionMode: 'auto',
      concurrency: 1,
      dailyLimit: 10,
      resultTimeoutMs: 1_800_000,
      actions: {},
    });
  });

  it('takes what a client asked for', () => {
    expect(
      actionsOf({
        permissionMode: 'bypassPermissions',
        concurrency: 2,
        dailyLimit: 5,
        resultTimeoutMs: 600_000,
        actions: { 'merge-upstream': { enabled: true, prompt: '/or-merge' } },
      }),
    ).toEqual({
      permissionMode: 'bypassPermissions',
      concurrency: 2,
      dailyLimit: 5,
      resultTimeoutMs: 600_000,
      actions: { 'merge-upstream': { enabled: true, prompt: '/or-merge' } },
    });
  });

  it('floors and ceilings a hand-edited spend, in both directions', () => {
    expect(actionsOf({ permissionMode: 'manual', concurrency: 0, dailyLimit: -5, resultTimeoutMs: 1 })).toMatchObject({
      concurrency: 1,
      dailyLimit: 0,
      resultTimeoutMs: 60_000,
    });
    expect(
      actionsOf({ permissionMode: 'manual', concurrency: 500, dailyLimit: 5_000, resultTimeoutMs: 9_999_999_999 }),
    ).toMatchObject({ concurrency: 4, dailyLimit: 50, resultTimeoutMs: 4 * 60 * 60 * 1000 });
  });

  /** This value is handed straight to a spawn, so one the CLI does not know must never reach it. */
  it('falls back to the shipped permission mode rather than passing one the CLI has no word for', () => {
    expect(actionsOf({ permissionMode: 'yolo', concurrency: 1, dailyLimit: 1, resultTimeoutMs: 60_000 })).toMatchObject({
      permissionMode: 'auto',
    });
    expect(actionsOf({ permissionMode: 7, concurrency: 1, dailyLimit: 1, resultTimeoutMs: 60_000 })).toMatchObject({
      permissionMode: 'auto',
    });
  });

  /** A later build naming an action this one does not perform must not cost the developer their configuration. */
  it('drops an action it does not know, and one shaped wrongly, rather than refusing the whole block', () => {
    expect(
      actionsOf({
        permissionMode: 'manual',
        concurrency: 1,
        dailyLimit: 1,
        resultTimeoutMs: 60_000,
        actions: { 'fix-checks': { enabled: true, prompt: '/x' } },
      }),
    ).toMatchObject({ actions: {} });
    expect(
      actionsOf({ permissionMode: 'manual', concurrency: 1, dailyLimit: 1, resultTimeoutMs: 60_000, actions: 'on' }),
    ).toMatchObject({ actions: {} });
  });

  it('reads an action written with neither field as off with nothing to run', () => {
    expect(
      actionsOf({
        permissionMode: 'manual',
        concurrency: 1,
        dailyLimit: 1,
        resultTimeoutMs: 60_000,
        actions: { 'merge-upstream': {} },
      }),
    ).toMatchObject({ actions: { 'merge-upstream': { enabled: false, prompt: '' } } });
  });

  it('refuses an actions block that is not one, rather than acting on a default nobody chose', () => {
    expect(actionsOf('on')).toMatchObject({ kind: 'bad-config' });
    expect(actionsOf({ permissionMode: 'manual', concurrency: 'two', dailyLimit: 1, resultTimeoutMs: 60_000 })).toMatchObject({
      kind: 'bad-config',
    });
  });
});

describe('how much the hub says about itself', () => {
  function levelOf(raw: unknown) {
    const parsed = parseHubConfig(config({ logLevel: raw } as never));

    return 'config' in parsed ? parsed.config.logLevel : parsed.failure;
  }

  it('defaults log settings in older configurations', () => {
    const parsed = parseHubConfig(config());

    expect('config' in parsed && parsed.config.logLevel).toBe('info');
  });

  it('takes the one floor a client can ask for beyond the default', () => {
    expect(levelOf('debug')).toBe('debug');
  });

  // An invalid optional field must not discard unrelated repository or login settings.
  it.each([['verbose'], [42], [null], [['debug']]])('falls back to info rather than refusing %s', (bad) => {
    expect(levelOf(bad)).toBe('info');
  });

  // Retain info-level lifecycle and refusal logs needed to diagnose hub startup.
  it.each([['warn'], ['error']])('refuses to take %s as a floor, because it would silence what happened', (level) => {
    expect(levelOf(level)).toBe('info');
  });
});

describe('what a session started from a card is prefilled with', () => {
  function promptOf(raw: unknown) {
    const parsed = parseHubConfig(config({ newSession: raw } as never));

    return 'config' in parsed ? parsed.config.newSession.prompt : parsed.failure;
  }

  it('defaults a configuration written before a card could start anything, rather than refusing it', () => {
    const parsed = parseHubConfig(config());

    expect('config' in parsed && parsed.config.newSession).toEqual({ prompt: '' });
  });

  it('takes the prompt as typed, since nothing here spends anything or starts anything unattended', () => {
    expect(promptOf({ prompt: '  Work on #{issue}.  ' })).toBe('  Work on #{issue}.  ');
  });

  // An invalid optional field must not discard unrelated repository or login settings.
  it.each([[42], [null], [['a prompt']], [{}]])('falls back to a bare session rather than refusing %s', (bad) => {
    expect(promptOf({ prompt: bad })).toBe('');
  });
});
