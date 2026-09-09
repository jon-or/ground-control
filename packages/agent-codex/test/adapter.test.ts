import { describe, expect, it } from 'vitest';
import { makeCodexAdapter, pidAliveOnMachine } from '../src/codex.js';
import { HOOK_MARKER_VERSION, activityDirOf, codexHooksPathOf, hookPathOf, markerPathOf } from '../src/hookScript.js';
import { HOME, machine } from './helpers.js';

const NOW = Date.now();
const THREAD = '01a07d5a-b5bd-7762-8ef8-4202ce964f31';
const STARTED = `{"type":"thread.started","thread_id":"${THREAD}"}`;
/** Match the dispatch thread to the marker for roster PID fallback tests. */
const STARTED_FOR_MARKER = '{"type":"thread.started","thread_id":"thread-1"}';

function dispatchInput() {
  return {
    path: 'codex',
    prompt: 'do the thing',
    name: 'gc',
    cwd: '/work/repo',
    permissionMode: 'dontAsk',
    model: null,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  };
}

const marker = JSON.stringify({
  v: HOOK_MARKER_VERSION,
  sessionId: 'thread-1',
  event: 'UserPromptSubmit',
  at: NOW,
  turnAt: NOW,
  turnId: 'turn-1',
  pid: 4242,
  startedAt: NOW,
  cwd: '/work/repo',
  transcriptPath: null,
  model: null,
  permissionMode: null,
  source: null,
  toolName: null,
  reason: null,
});

describe('the Codex adapter', () => {
  it.each([
    ['/profiles/user\\one', '/profiles/user\\one/hooks.json'],
    ['C:/', 'C:/hooks.json'],
    ['/', '/hooks.json'],
  ])('keeps detection and hook paths consistent for %s', (root, settings) => {
    const adapter = makeCodexAdapter({ alive: () => true, env: {} });
    adapter.storage!.configure(root);
    expect(adapter.enabledByDefault(machine({ dirs: { [root]: [] } }))).toBe(true);
    expect(adapter.activity!.settingsPath(HOME)).toBe(settings);
  });
  it('changes profile reads and hook paths while leaving Ground Control markers in place', async () => {
    const adapter = makeCodexAdapter({ alive: () => true, env: { CODEX_HOME: '/initial' } });
    const first = '/profiles/first';
    const second = '/profiles/second';
    const deps = machine({
      dirs: { [activityDirOf(HOME)]: ['thread-1.json'], [first]: [], [second]: [] },
      files: {
        [markerPathOf(HOME, 'thread-1')]: JSON.stringify({ ...JSON.parse(marker), profileRoot: first }),
        [`${first}/session_index.jsonl`]: JSON.stringify({ id: 'thread-1', thread_name: 'First profile' }),
      },
    });
    adapter.storage!.configure(first);
    expect(adapter.activity!.settingsPath(HOME)).toBe(`${first}/hooks.json`);
    expect(adapter.activity!.watchDir(HOME)).toBe(activityDirOf(HOME));
    expect(adapter.enabledByDefault(deps)).toBe(true);
    expect((await adapter.listSessions('codex', deps)).sessions).toHaveLength(1);
    expect(adapter.activity!.read(HOME, 'thread-1', deps.readText)).not.toBeNull();
    adapter.storage!.configure(second);
    expect(adapter.activity!.settingsPath(HOME)).toBe(`${second}/hooks.json`);
    expect((await adapter.listSessions('codex', deps)).sessions).toEqual([]);
    expect(adapter.activity!.read(HOME, 'thread-1', deps.readText)).toBeNull();
  });

  it('snapshots dispatch environments and preserves stop authorization after a profile change', async () => {
    const environments: NodeJS.ProcessEnv[] = [];
    const stopped: number[] = [];
    const base = { CODEX_HOME: '/ambient', TOKEN: 'test-only' };
    const adapter = makeCodexAdapter({ alive: () => true, env: base,
      start: async (_path, _args, options) => {
        environments.push(options.env!);
        return { pid: 7654, failure: null, firstLine: async () => STARTED };
      }, kill: (pid) => { stopped.push(pid); return true; },
    });
    adapter.storage!.configure('/profiles/first');
    expect(await adapter.dispatch!(dispatchInput())).toEqual({ shortId: THREAD });
    adapter.storage!.configure('/profiles/second');
    expect(await adapter.stopDispatch!('codex', THREAD)).toBeNull();
    expect(stopped).toEqual([7654]);
    expect(environments).toEqual([{ CODEX_HOME: '/profiles/first', TOKEN: 'test-only' }]);
    expect(base.CODEX_HOME).toBe('/ambient');
  });

  it('separates pending trust attempts by profile and ignores an old profile failure', async () => {
    const calls: { env: NodeJS.ProcessEnv; finish: (value: string | null) => void }[] = [];
    const adapter = makeCodexAdapter({ alive: () => true, env: {}, trust: (_path, _home, env) =>
      new Promise((finish) => { calls.push({ env: env!, finish }); }),
    });
    const hooks = Object.values(withOurHook())[0]!;
    const deps = machine({ files: { '/profiles/first/hooks.json': hooks, '/profiles/second/hooks.json': hooks } });
    adapter.storage!.configure('/profiles/first');
    await adapter.listSessions('codex', deps);
    adapter.storage!.configure('/profiles/second');
    await adapter.listSessions('codex', deps);
    expect(calls.map((call) => call.env['CODEX_HOME'])).toEqual(['/profiles/first', '/profiles/second']);
    adapter.storage!.configure('/profiles/first');
    await adapter.listSessions('codex', deps);
    expect(calls).toHaveLength(3);
    calls[0]!.finish('old profile failure');
    calls[1]!.finish(null);
    calls[2]!.finish(null);
    await Promise.resolve();
    expect((await adapter.listSessions('codex', deps)).failure).toBeNull();
    expect(calls).toHaveLength(3);
  });
  it('names itself and the command a dispatch spawns', () => {
    expect(makeCodexAdapter({ alive: () => true, env: {} })).toMatchObject({ id: 'codex', displayName: 'Codex', defaultPath: 'codex' });
  });

  /** Enable installed Codex without configuration; skip absent installations (R30). */
  it('is on where Codex keeps a home, and off where it does not', () => {
    const adapter = makeCodexAdapter({ alive: () => true, env: {} });

    expect(adapter.enabledByDefault(machine({ dirs: { [`${HOME}/.codex`]: ['config.toml'] } }))).toBe(true);
    expect(adapter.enabledByDefault(machine({}))).toBe(false);
  });

  it('detects Codex through CODEX_HOME', () => {
    const adapter = makeCodexAdapter({ alive: () => true, env: { CODEX_HOME: 'D:/elsewhere/codex' } });

    expect(adapter.enabledByDefault(machine({ dirs: { 'D:/elsewhere/codex': [] } }))).toBe(true);
    expect(adapter.enabledByDefault(machine({ dirs: { [`${HOME}/.codex`]: ['config.toml'] } }))).toBe(false);
  });

  /** Report untrusted hooks because they prevent marker-based discovery (R25, M41). */
  function withOurHook(): Record<string, string> {
    return {
      [codexHooksPathOf(HOME)]: JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${hookPathOf(HOME)}"`, async: true, timeout: 5 }] }] },
      }),
    };
  }

  it('starts one trust attempt and suppresses pending failures', async () => {
    const calls: string[] = [];
    const adapter = makeCodexAdapter({ alive: () => true, env: {}, trust: (path) => (calls.push(path), Promise.resolve(null)) });
    const deps = machine({ dirs: { [activityDirOf(HOME)]: [] }, files: withOurHook() });

    const first = await adapter.listSessions('D:/codex/codex.exe', deps);
    const second = await adapter.listSessions('D:/codex/codex.exe', deps);

    expect(calls).toEqual(['D:/codex/codex.exe']);
    expect(first.failure).toBeNull();
    expect(second.failure).toBeNull();
  });

  it('reports what stopped the attempt on the read after it failed', async () => {
    const adapter = makeCodexAdapter({ alive: () => true, env: {}, trust: () => Promise.resolve('Codex refused') });
    const deps = machine({ dirs: { [activityDirOf(HOME)]: [] }, files: withOurHook() });

    await adapter.listSessions('codex', deps);
    // Allow the asynchronous trust attempt to finish before the next poll.
    await Promise.resolve();
    const after = await adapter.listSessions('codex', deps);

    expect(after.failure?.subject).toBe('codex');
    expect(after.failure?.message).toContain('Codex refused');
  });

  it('asks nothing where the machine gives it no way to, and reports nothing it cannot act on', async () => {
    const adapter = makeCodexAdapter({ alive: () => true, env: {} });
    const deps = machine({ dirs: { [activityDirOf(HOME)]: [] }, files: withOurHook() });

    expect((await adapter.listSessions('codex', deps)).failure).toBeNull();
  });

  it('keeps a fault in what the hook wrote ahead of anything about trust', async () => {
    const adapter = makeCodexAdapter({ alive: () => true, env: {}, trust: () => Promise.resolve('Codex refused') });
    const deps = machine({ dirs: { [activityDirOf(HOME)]: ['thread-1.json'] }, files: withOurHook() });

    await adapter.listSessions('codex', deps);
    await Promise.resolve();

    expect((await adapter.listSessions('codex', deps)).failure?.message).toContain('could not be read');
  });

  it('exposes no classification capability', () => {
    expect(makeCodexAdapter({ alive: () => true, env: {} }).classify).toBeUndefined();
  });

  it('allows resume while the rollout exists', () => {
    const adapter = makeCodexAdapter({ alive: () => true, env: {} });
    const held = { agent: 'codex', sessionId: '01a072f9-c43a-73e2-a4fd-3a63e73ad152' } as never;
    const rollout = 'rollout-2026-09-05T15-09-26-01a072f9-c43a-73e2-a4fd-3a63e73ad152.jsonl';
    const root = `${HOME}/.codex/sessions`;
    const deps = machine({
      dirs: {
        [root]: ['2026'],
        [`${root}/2026`]: ['09'],
        [`${root}/2026/09`]: ['05'],
        [`${root}/2026/09/05`]: [rollout],
      },
    });

    expect(adapter.canResume!(held, deps)).toBe(true);
    // Resume by thread ID independently of its original checkout (M44).
    expect(adapter.canResume!(held, machine({}))).toBe(false);
  });

  /** Card actions require dispatch and stop capabilities together (R39). */
  it('offers dispatch only alongside a way to stop what it started', () => {
    const start = () => Promise.resolve({ pid: 1, failure: null, firstLine: () => Promise.resolve(null) });

    expect(makeCodexAdapter({ alive: () => true, env: {} }).dispatch).toBeUndefined();
    expect(makeCodexAdapter({ alive: () => true, env: {}, start }).dispatch).toBeUndefined();
    expect(makeCodexAdapter({ alive: () => true, env: {}, kill: () => true }).dispatch).toBeUndefined();

    const full = makeCodexAdapter({ alive: () => true, env: {}, start, kill: () => true });

    expect(full.dispatch).toBeDefined();
    expect(full.stopDispatch).toBeDefined();
  });

  it('stops a run it started, by the process it spawned', async () => {
    const signalled: number[] = [];
    const adapter = makeCodexAdapter({
      alive: () => true,
      env: {},
      start: () => Promise.resolve({ pid: 4242, failure: null, firstLine: () => Promise.resolve(STARTED) }),
      kill: (pid) => (signalled.push(pid), true),
    });

    const dispatched = await adapter.dispatch!(dispatchInput());

    expect(dispatched).toEqual({ shortId: THREAD });
    // The spawn PID permits stopping before any roster read.
    expect(await adapter.stopDispatch!('codex', THREAD)).toBeNull();
    expect(signalled).toEqual([4242]);
  });

  /** Stop only runs authorized by this adapter instance (R39). */
  it('refuses to stop a session the board did not start', async () => {
    const signalled: number[] = [];
    const adapter = makeCodexAdapter({
      alive: () => true,
      env: {},
      start: () => Promise.resolve({ pid: 1, failure: null, firstLine: () => Promise.resolve(null) }),
      kill: (pid) => (signalled.push(pid), true),
    });

    // The roster sees every Codex process on the machine, the developer's own included.
    await adapter.listSessions(
      'codex',
      machine({ dirs: { [activityDirOf(HOME)]: ['thread-1.json'] }, files: { [markerPathOf(HOME, 'thread-1')]: marker } }),
    );

    expect(await adapter.stopDispatch!('codex', 'thread-1')).toMatchObject({ kind: 'stop-unknown' });
    expect(signalled).toEqual([]);
  });

  it('uses roster PIDs when the dispatch PID is missing', async () => {
    const signalled: number[] = [];
    const adapter = makeCodexAdapter({
      alive: () => true,
      env: {},
      start: () => Promise.resolve({ pid: null, failure: null, firstLine: () => Promise.resolve(STARTED_FOR_MARKER) }),
      kill: (pid) => (signalled.push(pid), true),
    });

    await adapter.dispatch!(dispatchInput());
    await adapter.listSessions(
      'codex',
      machine({ dirs: { [activityDirOf(HOME)]: ['thread-1.json'] }, files: { [markerPathOf(HOME, 'thread-1')]: marker } }),
    );

    expect(await adapter.stopDispatch!('codex', 'thread-1')).toBeNull();
    expect(signalled).toEqual([4242]);
  });

  it('reports failure when no process was stopped', async () => {
    const adapter = makeCodexAdapter({
      alive: () => true,
      env: {},
      start: () => Promise.resolve({ pid: 4242, failure: null, firstLine: () => Promise.resolve(STARTED) }),
      kill: () => false,
    });

    await adapter.dispatch!(dispatchInput());

    expect(await adapter.stopDispatch!('codex', THREAD)).toMatchObject({ kind: 'stop-failed' });
  });

  it('reads a process this user may not signal as alive, because EPERM is not absence', () => {
    // Windows' System process, and init elsewhere: present, and not ours to signal.
    expect(pidAliveOnMachine(process.platform === 'win32' ? 4 : 1)).toBe(true);
  });

  it('points the install at the hooks file CODEX_HOME names', () => {
    const moved = makeCodexAdapter({ alive: () => true, env: { CODEX_HOME: 'd:/elsewhere/codex' } });

    expect(moved.activity!.settingsPath(HOME)).toBe('d:/elsewhere/codex/hooks.json');
  });
});
