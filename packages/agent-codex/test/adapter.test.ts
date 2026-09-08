import { describe, expect, it } from 'vitest';
import { makeCodexAdapter, pidAliveOnMachine } from '../src/codex.js';
import { HOOK_MARKER_VERSION, activityDirOf, codexHooksPathOf, hookPathOf, markerPathOf } from '../src/hookScript.js';
import { HOME, machine } from './helpers.js';

const NOW = Date.now();
const THREAD = '01a07d5a-b5bd-7762-8ef8-4202ce964f31';
const STARTED = `{"type":"thread.started","thread_id":"${THREAD}"}`;
/** A run whose thread is the one the marker below names, so a stop can fall back to what the roster observed. */
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
  it('ships off, so a machine without Codex is never told it is missing', () => {
    expect(makeCodexAdapter({ alive: () => true, env: {} })).toMatchObject({ id: 'codex', displayName: 'Codex', defaultPath: 'codex', defaultEnabled: false });
  });

  it('offers no classification, which is the one thing it cannot yet do', () => {
    expect(makeCodexAdapter({ alive: () => true, env: {} }).classify).toBeUndefined();
  });

  it('says a saved thread can be opened while Codex still holds its rollout', () => {
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
    // The saved checkout is not the question: a thread is opened by its id, wherever it once ran (§44).
    expect(adapter.canResume!(held, machine({}))).toBe(false);
  });

  /** R15: a run nobody can take back is worse than no automation, so the two are offered together or not at all. */
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
    // No roster read has happened, and none is needed: the board spawned this one and knows its process.
    expect(await adapter.stopDispatch!('codex', THREAD)).toBeNull();
    expect(signalled).toEqual([4242]);
  });

  /** R15's other half: a stop must be able to reach what the board started, and nothing else on the machine. */
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

  it('falls back to the process the markers report, which is what a restarted hub has', async () => {
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

  it('says nothing answered rather than reporting a run stopped', async () => {
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
