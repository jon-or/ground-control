import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, DebriefForkInput, DebriefForkResult, DebriefRange, HistoricalSession, Session, TextOutcome } from '@ground-control/core';
import { DebriefRunner, promptFor, underHome } from '../src/debrief.js';
import type { DebriefDeps, DebriefSessions } from '../src/debrief.js';
import { EMPTY_DEBRIEF_STATE, makeDebriefStore } from '../src/debriefStore.js';
import type { DebriefLogEntry, DebriefState, DebriefStore } from '../src/debriefStore.js';
import { captureLog, fakeReaders, fakeSession, loggedOf, tempHome } from './helpers.js';

const MINUTE = 60_000;
const NOW = 1_790_000_000_000;
const HOME = '/home/dev';
const DIR = '/home/dev/.claude/.wip/debrief';
const SCRIPT = '/home/dev/.claude/tools/agent-delegate/debrief.mjs';
const PROMPT = '/home/dev/.claude/skills/friction-review/prompt.md';
const A = 'a1b2c3d4-0000-4000-8000-00000000000a';
const B = 'a1b2c3d4-0000-4000-8000-00000000000b';
const THREAD = '0190a000-0000-7000-8000-000000000001';

/** A live Claude session whose last event is a Stop the given minutes ago. */
function idle(sessionId: string, minutes: number, over: Partial<Session> = {}, now = NOW): Session {
  const at = now - minutes * MINUTE;
  return fakeSession({ agent: 'claude', sessionId, cwd: `d:/work/${sessionId.slice(-1)}`, details: { kind: 'interactive' }, activity: { phase: 'idle', since: at, at, event: 'Stop' }, ...over });
}

function closed(sessionId: string, minutes: number): HistoricalSession {
  return { agent: 'claude', sessionId, title: null, cwd: `d:/work/${sessionId.slice(-1)}`, branch: null, issueNumber: null, repository: null, updatedAt: NOW - minutes * MINUTE };
}

function answeredLine(sessionId: string): DebriefLogEntry {
  return { v: 1, at: '', provider: 'claude', sessionId, parentSessionId: null, cwd: '', fromMessageUuid: null, throughMessageUuid: null, skills: [], toolCalls: 12, cache: null, friction: [] };
}

function range(through: string, toolCalls = 12, delegated: string[] = []): DebriefRange {
  return { throughMessageUuid: through, toolCalls, skills: ['skill-a'], delegated, fromPrompt: null };
}

interface Rig {
  runner: DebriefRunner;
  deps: DebriefDeps;
  clock: { now: number };
  sessions: DebriefSessions | null;
  /** The range each session's transcript holds now, and the from-uuid each read was asked for. */
  ranges: Map<string, DebriefRange | null>;
  reads: [string, string | null][];
  forks: DebriefForkInput[];
  /** The next fork answers; each is taken once, and a fork with none left fails the test. */
  answers: (DebriefForkResult | Promise<DebriefForkResult> | (() => Promise<DebriefForkResult>))[];
  codex: [string, string, string, string | null][];
  codexAnswers: TextOutcome[];
  store: DebriefStore & { state: DebriefState | null; logs: DebriefLogEntry[]; failWrite: boolean; failAppend: boolean; logUnreadable: boolean; dirs: string[] };
  /** The prompt file's text, or null when it does not exist. */
  prompt: string | null;
  files: Set<string>;
  messages: string[];
}

const FRICTION = [{ what: 'init-worktree failed', source: 'skill:init-worktree', workaround: 'removed the binding', cost: '6 tool calls', evidence: 'appcmd error', fix: 'init-worktree step 4: remove the binding' }];
const answered = (friction = FRICTION, subagents: string[] = []): DebriefForkResult => ({ friction, subagents, cache: { read: 75_491, created: 4_023, costUsd: 0.048 } });

const SETTINGS = { enabled: true, directory: '', promptPath: '', codexScript: '' };

function rig(): Rig {
  const logging = captureLog();
  const state: Rig = {
    runner: undefined as unknown as DebriefRunner,
    deps: undefined as unknown as DebriefDeps,
    clock: { now: NOW },
    sessions: { live: [], history: [], unreadable: new Set() },
    ranges: new Map(),
    reads: [],
    forks: [],
    answers: [],
    codex: [],
    codexAnswers: [],
    files: new Set(),
    messages: logging.messages,
    prompt: 'Report friction in {{scope}}.',
    store: {
      state: structuredClone(EMPTY_DEBRIEF_STATE),
      logs: [],
      failWrite: false,
      failAppend: false,
      logUnreadable: false,
      dirs: [],
      readState: () => (state.store.state === null ? null : structuredClone(state.store.state)),
      writeState: (next) => {
        if (state.store.failWrite) return false;
        state.store.state = structuredClone(next);
        return true;
      },
      appendLog: (entry) => {
        if (state.store.failAppend) return false;
        state.store.logs.push(entry);
        return true;
      },
      logged: () => (state.store.logUnreadable ? { unreadable: true } : loggedOf(state.store.logs)),
    },
  };
  const adapter: AgentAdapter = {
    id: 'claude',
    displayName: 'Claude',
    defaultPath: 'claude',
    enabledByDefault: () => true,
    listSessions: async () => ({ sessions: [], failure: null }),
    debrief: {
      // A transcript's write time changes with what it holds, as a real one does.
      transcriptWrittenAt: (_readers, session) => {
        const held = state.ranges.get(session.sessionId);
        return held === undefined ? null : [...JSON.stringify(held)].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) % 1_000_003, 7);
      },
      readRange: (_readers, session, from) => {
        state.reads.push([session.sessionId, from]);
        return state.ranges.get(session.sessionId) ?? null;
      },
      fork: async (input) => {
        state.forks.push(input);
        const next = state.answers.shift();
        if (next === undefined) throw new Error(`no answer is queued for the fork of ${input.sessionId}`);
        return typeof next === 'function' ? next() : next;
      },
    },
  };
  const deps: DebriefDeps = {
    now: () => state.clock.now,
    log: logging.log,
    home: HOME,
    readers: () => ({
      ...fakeReaders({}, HOME),
      mtime: (path) => (state.files.has(path) ? NOW : null),
      readText: (path) => (path === PROMPT ? state.prompt : null),
    }),
    agents: [adapter],
    sessions: async () => state.sessions,
    store: (dir) => {
      state.store.dirs.push(dir);
      return state.store;
    },
    runCodex: async (script, thread, prompt, since) => {
      state.codex.push([script, thread, prompt, since]);
      const next = state.codexAnswers.shift();
      if (next === undefined) throw new Error(`no answer is queued for Codex thread ${thread}`);
      return next;
    },
    newId: () => `fork-${state.forks.length + 1}`,
  };

  state.deps = deps;
  state.runner = new DebriefRunner(deps);
  state.runner.configure(SETTINGS, [{ id: 'claude', path: 'claude-cli' }]);

  return state;
}

/** A runner over the rig's fakes with its own roster reader. */
function rigRunner(r: Rig, sessions: DebriefDeps['sessions']): DebriefRunner {
  const runner = new DebriefRunner({ ...r.deps, sessions });
  runner.configure(SETTINGS, [{ id: 'claude', path: 'claude-cli' }]);
  return runner;
}

describe('which sessions a scan debriefs', () => {
  it('forks a live session 45 minutes after its Stop, in its directory, and logs what it reports', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 45)];
    r.ranges.set(A, range('m-12', 12, [THREAD]));
    r.answers.push(answered());

    await r.runner.scan();

    expect(r.forks).toEqual([{ path: 'claude-cli', sessionId: A, forkId: 'fork-1', cwd: 'd:/work/a', prompt: 'Report friction in the whole conversation.', timeoutMs: 600_000, signal: expect.any(AbortSignal), readers: expect.objectContaining({ home: HOME }), subagentsDebriefed: {}, now: NOW }]);
    expect(r.store.dirs).toEqual([DIR]);
    expect(r.store.logs).toEqual([{
      v: 1, at: '2026-09-21T14:13:20.000Z', provider: 'claude', sessionId: A, parentSessionId: null, cwd: 'd:/work/a',
      fromMessageUuid: null, throughMessageUuid: 'm-12', skills: ['skill-a'], toolCalls: 12,
      cache: { read: 75_491, created: 4_023, costUsd: 0.048 }, friction: FRICTION, startedAt: '2026-09-21T14:13:20.000Z', subagents: [], delegated: [THREAD],
    }]);
    expect(r.store.state?.sessions[A]).toEqual({ throughMessageUuid: 'm-12', debriefedAt: '2026-09-21T14:13:20.000Z', attempts: 0, lastError: null, attemptedAt: null, attemptedThrough: null });
  });

  it('forks a closed session from history whose transcript is 45 to 60 minutes old', async () => {
    const r = rig();
    r.sessions!.history = [closed(A, 59), closed(B, 60)];
    r.ranges.set(A, range('m-12'));
    r.ranges.set(B, range('m-40'));
    r.answers.push(answered([]));

    await r.runner.scan();

    expect(r.forks.map((fork) => fork.sessionId)).toEqual([A]);
    expect(r.store.logs.map((entry) => [entry.sessionId, entry.friction])).toEqual([[A, []]]);
  });

  it('skips a session too recent, past the cache, still working, a live background job, and another agent', async () => {
    const r = rig();
    r.sessions!.live = [
      idle(A, 44),
      idle(B, 61),
      idle('c1', 50, { activity: { phase: 'running', since: NOW - 50 * MINUTE, at: NOW - 50 * MINUTE, event: 'Stop', backgroundTasks: 1 } }),
      idle('d1', 50, { activity: { phase: 'running', since: NOW - 50 * MINUTE, at: NOW - 50 * MINUTE, event: 'PostToolBatch' } }),
      idle('e1', 50, { details: { kind: 'background' }, pid: 4242 }),
      idle('f1', 50, { agent: 'codex' }),
      idle('g1', 50, { activity: null }),
    ];
    for (const id of [A, B, 'c1', 'd1', 'e1', 'f1', 'g1']) r.ranges.set(id, range('m-12'));

    await r.runner.scan();

    expect(r.reads).toEqual([]);
    expect(r.forks).toEqual([]);
  });

  it('forks a background job once its process has gone, and takes a live session over its history entry', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 50, { details: { kind: 'background' }, pid: null })];
    r.sessions!.history = [closed(A, 50)];
    r.ranges.set(A, range('m-12'));
    r.answers.push(answered());

    await r.runner.scan();

    expect(r.forks.map((fork) => fork.sessionId)).toEqual([A]);
  });

  it('skips work under ten tool calls, and a session with nothing new since its debrief', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 50), idle(B, 50)];
    r.ranges.set(A, range('m-9', 9));
    r.ranges.set(B, range('m-30', 12));
    r.store.state!.sessions[B] = { throughMessageUuid: 'm-30', debriefedAt: '2026-09-21T13:00:00.000Z', attempts: 0, lastError: null, attemptedAt: null, attemptedThrough: null };

    await r.runner.scan();

    expect(r.reads).toEqual([[A, null], [B, 'm-30']]);
    expect(r.forks).toEqual([]);
  });

  it('debriefs a turn that finished while the last debrief ran, though its Stop is older than that debrief', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 50)];
    r.ranges.set(A, range('m-12'));
    r.store.state!.sessions[A] = { throughMessageUuid: 'm-5', debriefedAt: new Date(NOW - 49 * MINUTE).toISOString(), attempts: 0, lastError: null, attemptedAt: null, attemptedThrough: null };
    r.answers.push(answered([]));

    await r.runner.scan();

    expect(r.reads).toEqual([[A, 'm-5']]);
    expect(r.store.logs.map((entry) => [entry.fromMessageUuid, entry.throughMessageUuid])).toEqual([['m-5', 'm-12']]);
  });

  it('records when each subagent the fork was shown was debriefed, and hands those times to the next fork of the session', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 45), idle(B, 45)];
    r.ranges.set(A, range('m-12'));
    r.ranges.set(B, range('m-20'));
    r.store.state!.subagents = { [`${B}/z9`]: '2026-09-21T10:00:00.000Z' };
    r.answers.push(answered([], ['a1', 'b2']), answered([]));

    await r.runner.scan();

    expect(r.forks.map((fork) => [fork.sessionId, fork.subagentsDebriefed])).toEqual([[A, {}], [B, { z9: '2026-09-21T10:00:00.000Z' }]]);
    expect(r.store.state?.subagents).toEqual({
      [`${B}/z9`]: '2026-09-21T10:00:00.000Z',
      [`${A}/a1`]: '2026-09-21T14:13:20.000Z',
      [`${A}/b2`]: '2026-09-21T14:13:20.000Z',
    });
  });

  it('debriefs a session again for the work after its last debriefed message', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 45)];
    r.ranges.set(A, { ...range('m-40', 15), fromPrompt: 'Now merge the base <and> "ship" it' });
    r.store.state!.sessions[A] = { throughMessageUuid: 'm-12', debriefedAt: new Date(NOW - 3 * 60 * MINUTE).toISOString(), attempts: 0, lastError: null, attemptedAt: null, attemptedThrough: null };
    r.answers.push(answered([]));

    await r.runner.scan();

    expect(r.reads).toEqual([[A, 'm-12']]);
    expect(r.forks[0]?.prompt).toBe('Report friction in the work after the user message that begins "Now merge the base <and> "ship" it".');
    expect(promptFor('in {{scope}}.', { ...range('m-1'), fromPrompt: "Fix $& and $' in the regex" })).toBe('in the work after the user message that begins "Fix $& and $\' in the regex".');
    expect(r.store.logs[0]).toMatchObject({ fromMessageUuid: 'm-12', throughMessageUuid: 'm-40', toolCalls: 15 });
    expect(r.store.state?.sessions[A]?.throughMessageUuid).toBe('m-40');
  });

  it('runs one fork at a time, the session nearest cache expiry first, and drops a fork id from the roster while it runs', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 46), idle(B, 55)];
    r.ranges.set(A, range('m-12'));
    r.ranges.set(B, range('m-20'));
    let release!: (result: DebriefForkResult) => void;
    r.answers.push(new Promise((resolve) => { release = resolve; }), answered([]));

    const scan = r.runner.scan();
    await new Promise((resolve) => setImmediate(resolve));

    expect(r.forks.map((fork) => fork.sessionId)).toEqual([B]);
    expect([...r.runner.sessionIds()]).toEqual(['fork-1']);

    // A second scan while the first runs starts nothing.
    await r.runner.scan();
    expect(r.forks).toHaveLength(1);

    release(answered([]));
    await scan;

    expect(r.forks.map((fork) => fork.sessionId)).toEqual([B, A]);
    expect([...r.runner.sessionIds()]).toEqual([]);
  });

  it('reads the roster again before each fork, and skips a session that resumed while an earlier fork ran', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 50), idle(B, 46)];
    r.ranges.set(A, range('m-12'));
    r.ranges.set(B, range('m-20'));
    let reads = 0;
    const sessions = r.sessions!;
    r.runner = rigRunner(r, async () => {
      reads++;
      return sessions;
    });
    r.answers.push(async () => {
      sessions.live = [sessions.live[0]!, idle(B, 0, { activity: { phase: 'running', since: NOW, at: NOW, event: 'UserPromptSubmit' } })];
      return answered([]);
    });

    await r.runner.scan();

    expect(r.forks.map((fork) => fork.sessionId)).toEqual([A]);
    expect(reads).toBe(2);
  });

  it('starts no further fork once debriefs are turned off or reconfigured during a scan', async () => {
    for (const change of [{ ...SETTINGS, enabled: false }, { ...SETTINGS, directory: 'd:/elsewhere' }]) {
      const r = rig();
      r.sessions!.live = [idle(A, 50), idle(B, 46)];
      r.ranges.set(A, range('m-12'));
      r.ranges.set(B, range('m-20'));
      r.answers.push(async () => {
        r.runner.configure(change, [{ id: 'claude', path: 'claude-cli' }]);
        return answered([]);
      });

      await r.runner.scan();

      expect(r.forks.map((fork) => fork.sessionId)).toEqual([A]);
      expect(r.store.logs.map((entry) => entry.sessionId)).toEqual([A]);
    }
  });

  it('holds a state it could not write, starts nothing until it is written, then debriefs only the work after it', async () => {
    const r = rig();
    r.files.add(SCRIPT);
    r.sessions!.live = [idle(A, 45), idle(B, 45)];
    r.ranges.set(A, range('m-12', 12, [THREAD]));
    r.ranges.set(B, range('m-20'));
    r.answers.push(answered());
    r.store.failWrite = true;

    await r.runner.scan();

    // The failed write stops the scan before B's fork and before asking about the thread.
    expect(r.forks.map((fork) => fork.sessionId)).toEqual([A]);
    expect(r.codex).toEqual([]);
    expect(r.store.state?.sessions[A]).toBeUndefined();

    r.clock.now += MINUTE;
    await r.runner.scan();
    expect(r.forks).toHaveLength(1);
    expect(r.messages).toContain(`${DIR}/state.json cannot be written; debriefs wait until it can.`);

    // The session went on, and a later write succeeds.
    r.store.failWrite = false;
    r.sessions!.live = [idle(A, 45, {}, r.clock.now)];
    r.ranges.set(A, range('m-24', 14));
    r.answers.push(answered([]));
    r.codexAnswers.push({ ok: true, text: JSON.stringify({ friction: [] }) });
    await r.runner.scan();

    expect(r.forks.map((fork) => fork.sessionId)).toEqual([A, A]);
    expect(r.store.logs.map((entry) => [entry.provider, entry.fromMessageUuid, entry.throughMessageUuid])).toEqual([
      ['claude', null, 'm-12'], ['codex', null, null], ['claude', 'm-12', 'm-24'],
    ]);
  });

  it('takes up from the log a debrief the state lost when the hub stopped, even after the session went on', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 45)];
    r.ranges.set(A, range('m-24', 14));
    r.store.logs.push({ ...answeredLine(A), throughMessageUuid: 'm-12', at: '2026-09-21T13:10:00.000Z', startedAt: '2026-09-21T13:08:00.000Z', subagents: ['a1'] });

    r.answers.push(answered([]));

    await r.runner.scan();

    // The recovered line's subagents keep the fork start as their last debrief, and the next fork is told so.
    expect(r.forks[0]?.subagentsDebriefed).toEqual({ a1: '2026-09-21T13:08:00.000Z' });

    // In the same scan, since the session may leave its window by the next.
    expect(r.forks).toHaveLength(1);
    expect(r.reads.at(-1)).toEqual([A, 'm-12']);
    expect(r.store.logs.at(-1)).toMatchObject({ fromMessageUuid: 'm-12', throughMessageUuid: 'm-24' });
  });

  it('asks the Codex threads of a recovered debrief, each only about turns after its own logged line', async () => {
    const r = rig();
    r.files.add(SCRIPT);
    r.sessions!.live = [idle(A, 45)];
    r.ranges.set(A, range('m-12'));
    r.store.logs.push(
      { ...answeredLine(A), throughMessageUuid: 'm-12', at: '2026-09-21T13:10:00.000Z', delegated: [THREAD, 'later'] },
      { ...answeredLine(THREAD), provider: 'codex', parentSessionId: A, throughMessageUuid: null, at: '2026-09-21T13:11:00.000Z' },
    );
    r.codexAnswers.push({ ok: false, reason: 'failed', detail: 'no turn since', exitCode: 3 }, { ok: true, text: JSON.stringify({ friction: [] }) });

    await r.runner.scan();

    expect(r.forks).toEqual([]);
    expect(r.codex).toEqual([[SCRIPT, THREAD, PROMPT, '2026-09-21T13:11:00.000Z'], [SCRIPT, 'later', PROMPT, null]]);
    expect(r.store.state?.codex[THREAD]).toMatchObject({ debriefedAt: '2026-09-21T13:11:00.000Z', pending: false, lastError: null });
    expect(r.store.state?.codex.later).toMatchObject({ parentSessionId: A, pending: false, debriefedAt: '2026-09-21T14:13:20.000Z' });
    expect(r.store.logs.filter((entry) => entry.provider === 'codex').map((entry) => entry.sessionId)).toEqual([THREAD, 'later']);
  });

  it('takes up a logged debrief and asks its Codex threads after the session has left its window', async () => {
    const r = rig();
    r.files.add(SCRIPT);
    r.sessions!.live = [idle(A, 61)];
    r.ranges.set(A, range('m-12'));
    r.store.logs.push({ ...answeredLine(A), cwd: 'd:/work/a', throughMessageUuid: 'm-12', at: '2026-09-21T13:10:00.000Z', delegated: [THREAD] });
    r.codexAnswers.push({ ok: true, text: JSON.stringify({ friction: [] }) });

    await r.runner.scan();

    expect(r.forks).toEqual([]);
    expect(r.store.state?.sessions[A]).toMatchObject({ throughMessageUuid: 'm-12', debriefedAt: '2026-09-21T13:10:00.000Z' });
    expect(r.codex).toEqual([[SCRIPT, THREAD, PROMPT, null]]);
    expect(r.store.state?.codex[THREAD]).toMatchObject({ parentSessionId: A, cwd: 'd:/work/a', pending: false });
  });

  it('writes an answer held by a failed append to the directory it came from after the setting moves', async () => {
    const r = rig();
    const other = { ...r.store, logs: [] as DebriefLogEntry[], appendLog: (entry: DebriefLogEntry) => (other.logs.push(entry), true), writeState: () => true, readState: () => structuredClone(EMPTY_DEBRIEF_STATE), logged: () => loggedOf([]) };
    const runner = new DebriefRunner({ ...r.deps, store: (dir) => (dir === DIR ? r.store : other) });
    runner.configure(SETTINGS, [{ id: 'claude', path: 'claude-cli' }]);
    r.sessions!.live = [idle(A, 45)];
    r.ranges.set(A, range('m-12'));
    r.store.failAppend = true;
    r.answers.push(answered());

    await runner.scan();
    runner.configure({ ...SETTINGS, directory: '/elsewhere' }, [{ id: 'claude', path: 'claude-cli' }]);
    await runner.scan();

    expect(r.forks).toHaveLength(1);
    expect(r.messages).toContain(`${DIR}/log cannot be written; debriefs wait until it can.`);

    r.store.failAppend = false;
    r.answers.push(answered([]));
    await runner.scan();

    expect(r.store.logs).toEqual([expect.objectContaining({ sessionId: A, throughMessageUuid: 'm-12', friction: FRICTION })]);
    expect(r.store.state?.sessions[A]).toMatchObject({ throughMessageUuid: 'm-12' });
    expect(other.logs).toEqual([expect.objectContaining({ sessionId: A, throughMessageUuid: 'm-12', friction: [] })]);
  });

  it('forks nothing while the log cannot be read, since whether a range was debriefed is unknown', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 45)];
    r.ranges.set(A, range('m-12'));
    r.store.logUnreadable = true;

    await r.runner.scan();

    expect(r.forks).toEqual([]);
    expect(r.messages).toContain(`${DIR}/log cannot be read, so what was debriefed is unknown; debriefs wait until it can.`);
  });

  it('skips a session that aged past the cache while an earlier fork ran', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 58), idle(B, 57)];
    r.ranges.set(A, range('m-12'));
    r.ranges.set(B, range('m-20'));
    r.answers.push(async () => {
      r.clock.now += 3 * MINUTE;
      return answered([]);
    });

    await r.runner.scan();

    expect(r.forks.map((fork) => fork.sessionId)).toEqual([A]);
  });
});

describe('a failed debrief', () => {
  it('records the attempt without a log line, waits five minutes, and abandons the range after three', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 45)];
    r.ranges.set(A, range('m-12'));
    const failed: DebriefForkResult = { failure: { subject: 'claude', kind: 'debrief-unparsable', message: 'The debrief answer was not the friction JSON: none', remedy: '' } };

    r.answers.push(failed);
    await r.runner.scan();

    expect(r.store.logs).toEqual([]);
    expect(r.store.state?.sessions[A]).toEqual({
      throughMessageUuid: null, debriefedAt: null, attempts: 1, lastError: 'The debrief answer was not the friction JSON: none',
      attemptedAt: '2026-09-21T14:13:20.000Z', attemptedThrough: 'm-12',
    });

    r.clock.now += 4 * MINUTE;
    await r.runner.scan();
    expect(r.forks).toHaveLength(1);

    r.clock.now += MINUTE;
    r.answers.push(failed);
    await r.runner.scan();
    r.clock.now += 5 * MINUTE;
    r.answers.push(failed);
    await r.runner.scan();

    expect(r.forks).toHaveLength(3);
    expect(r.store.state?.sessions[A]?.attempts).toBe(3);
    expect(r.messages.filter((message) => message.includes('failed (attempt'))).toHaveLength(3);
  });

  it('abandons a range after three failures while the session is still in its window', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 50)];
    r.ranges.set(A, range('m-12'));
    const seeded = { throughMessageUuid: null, debriefedAt: null, lastError: 'x', attemptedAt: new Date(NOW - 6 * MINUTE).toISOString(), attemptedThrough: 'm-12' };

    r.store.state!.sessions[A] = { ...seeded, attempts: 3 };
    await r.runner.scan();
    expect(r.forks).toEqual([]);

    r.store.state!.sessions[A] = { ...seeded, attempts: 2 };
    r.answers.push(answered([]));
    await r.runner.scan();
    expect(r.forks).toHaveLength(1);
  });

  it('starts counting again when new work arrives after an abandoned range', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 45)];
    r.ranges.set(A, range('m-50'));
    r.store.state!.sessions[A] = { throughMessageUuid: null, debriefedAt: null, attempts: 3, lastError: 'x', attemptedAt: new Date(NOW - 2 * 60 * MINUTE).toISOString(), attemptedThrough: 'm-12' };
    r.answers.push({ failure: { subject: 'claude', kind: 'debrief-failed', message: 'timed out after 300s', remedy: '' } });

    await r.runner.scan();

    expect(r.store.state?.sessions[A]).toMatchObject({ attempts: 1, attemptedThrough: 'm-50', lastError: 'timed out after 300s' });
  });

  it('holds an answer whose log line could not be written, forks nothing until it is written, and does not ask again', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 45), idle(B, 45)];
    r.ranges.set(A, range('m-12'));
    r.ranges.set(B, range('m-20'));
    r.store.failAppend = true;
    r.answers.push(answered());

    await r.runner.scan();
    r.clock.now += 5 * MINUTE;
    r.sessions!.live = [idle(A, 50), idle(B, 50)];
    await r.runner.scan();

    expect(r.forks.map((fork) => fork.sessionId)).toEqual([A]);
    expect(r.store.logs).toEqual([]);
    expect(r.store.state?.sessions[A]).toBeUndefined();
    expect(r.messages).toContain(`${DIR}/log cannot be written; debriefs wait until it can.`);

    r.store.failAppend = false;
    r.answers.push(answered([]));
    await r.runner.scan();

    expect(r.forks.map((fork) => fork.sessionId)).toEqual([A, B]);
    expect(r.store.logs.map((entry) => [entry.sessionId, entry.throughMessageUuid, entry.friction])).toEqual([[A, 'm-12', FRICTION], [B, 'm-20', []]]);
    expect(r.store.state?.sessions[A]).toMatchObject({ throughMessageUuid: 'm-12', attempts: 0, lastError: null });
  });
});

describe('when a scan debriefs nothing', () => {
  it('runs nothing while disabled, without the prompt, with an unreadable state, or without a Claude roster', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 45)];
    r.ranges.set(A, range('m-12'));

    r.runner.configure({ ...SETTINGS, enabled: false }, [{ id: 'claude', path: 'claude-cli' }]);
    await r.runner.scan();
    expect(r.store.dirs).toEqual([]);

    r.runner.configure(SETTINGS, [{ id: 'codex', path: 'codex' }]);
    await r.runner.scan();
    expect(r.store.dirs).toEqual([]);

    r.runner.configure(SETTINGS, [{ id: 'claude', path: 'claude-cli' }]);
    r.prompt = null;
    await r.runner.scan();
    r.prompt = ' \n';
    await r.runner.scan();

    r.prompt = 'Report friction in {{scope}}.';
    r.store.state = null;
    await r.runner.scan();

    r.store.state = structuredClone(EMPTY_DEBRIEF_STATE);
    r.sessions!.unreadable = new Set(['claude']);
    await r.runner.scan();

    r.sessions = null;
    await r.runner.scan();

    expect(r.forks).toEqual([]);
    expect(r.messages).toEqual([
      'Claude is not enabled, so no session is debriefed.',
      `No debrief prompt at ${PROMPT}, so no session is debriefed.`,
      `${DIR}/state.json cannot be read; debriefs wait until it can.`,
      'The Claude session list could not be read, so no session is debriefed.',
    ]);
  });

  it('stops forking once disposed, and passes the aborted signal to the running fork', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 45)];
    r.ranges.set(A, range('m-12'));
    let release!: (result: DebriefForkResult) => void;
    r.answers.push(new Promise((resolve) => { release = resolve; }));

    const scan = r.runner.scan();
    await new Promise((resolve) => setImmediate(resolve));
    r.runner.dispose();

    expect(r.forks[0]?.signal.aborted).toBe(true);

    release({ failure: { subject: 'claude', kind: 'debrief-aborted', message: 'command cancelled before completion', remedy: '' } });
    await scan;
    await r.runner.scan();

    expect(r.forks).toHaveLength(1);
  });
});

describe('the Codex threads a session delegated to', () => {
  const SANDBOX = { what: 'sandbox refused the build', source: 'env:codex-sandbox', workaround: 'none', cost: '2 tool calls', evidence: 'EPERM', fix: 'unknown', severity: 'high' };
  const AT = '2026-09-21T14:13:20.000Z';

  it('asks the Codex command about each thread the range named, and logs its answer against the parent in the same pass', async () => {
    const r = rig();
    r.files.add(SCRIPT);
    r.sessions!.live = [idle(A, 45)];
    r.ranges.set(A, range('m-12', 12, [THREAD, 'not-codex', 'broken']));
    r.answers.push(answered([]));
    r.codexAnswers.push(
      { ok: true, text: JSON.stringify({ friction: [SANDBOX] }) },
      { ok: false, reason: 'failed', detail: 'Command failed', exitCode: 3 },
      { ok: false, reason: 'failed', detail: 'A delegated turn is running on this thread', exitCode: 1 },
    );

    await r.runner.scan();

    expect(r.codex).toEqual([[SCRIPT, THREAD, PROMPT, null], [SCRIPT, 'not-codex', PROMPT, null], [SCRIPT, 'broken', PROMPT, null]]);
    expect(r.store.logs).toEqual([
      expect.objectContaining({ provider: 'claude', sessionId: A }),
      {
        v: 1, at: AT, provider: 'codex', sessionId: THREAD, parentSessionId: A, cwd: 'd:/work/a',
        fromMessageUuid: null, throughMessageUuid: null, skills: null, toolCalls: null, cache: null, friction: [SANDBOX],
      },
    ]);
    expect(r.store.state?.codex).toEqual({
      [THREAD]: { parentSessionId: A, cwd: 'd:/work/a', debriefedAt: AT, lastError: null, pending: false, attempts: 0, attemptedAt: null },
      'not-codex': { parentSessionId: A, cwd: 'd:/work/a', debriefedAt: null, lastError: null, pending: false, attempts: 0, attemptedAt: null },
      broken: { parentSessionId: A, cwd: 'd:/work/a', debriefedAt: null, lastError: 'A delegated turn is running on this thread', pending: true, attempts: 1, attemptedAt: AT },
    });
    expect(r.messages).toContain('Codex debrief of broken failed (attempt 1 of 3): A delegated turn is running on this thread');
  });

  it('keeps a failed attempt counted when its state cannot be written, and asks nothing more until it can', async () => {
    const r = rig();
    r.files.add(SCRIPT);
    r.store.state!.codex.broken = { parentSessionId: A, cwd: 'd:/work/a', debriefedAt: null, lastError: 'locked', pending: true, attempts: 1, attemptedAt: '2026-09-21T14:00:00.000Z' };
    r.store.failWrite = true;
    r.codexAnswers.push({ ok: false, reason: 'failed', detail: 'locked', exitCode: 1 });

    await r.runner.scan();
    r.clock.now += 10 * MINUTE;
    await r.runner.scan();

    expect(r.codex).toHaveLength(1);

    r.store.failWrite = false;
    r.clock.now += MINUTE;
    r.codexAnswers.push({ ok: false, reason: 'failed', detail: 'locked', exitCode: 1 });
    await r.runner.scan();

    expect(r.codex).toHaveLength(2);
    expect(r.store.state?.codex.broken).toMatchObject({ attempts: 3, pending: false });
  });

  it('retries a failed thread five minutes later without its parent, and stops after three failures', async () => {
    const r = rig();
    r.files.add(SCRIPT);
    r.store.state!.codex.broken = { parentSessionId: A, cwd: 'd:/work/a', debriefedAt: null, lastError: 'locked', pending: true, attempts: 1, attemptedAt: AT };
    const locked: TextOutcome = { ok: false, reason: 'failed', detail: 'locked', exitCode: 1 };

    r.clock.now += 4 * MINUTE;
    await r.runner.scan();
    expect(r.codex).toEqual([]);

    r.clock.now += MINUTE;
    r.codexAnswers.push(locked);
    await r.runner.scan();
    r.clock.now += 5 * MINUTE;
    r.codexAnswers.push(locked);
    await r.runner.scan();
    r.clock.now += 5 * MINUTE;
    await r.runner.scan();

    expect(r.codex).toHaveLength(2);
    expect(r.forks).toEqual([]);
    expect(r.store.state?.codex.broken).toMatchObject({ pending: false, attempts: 3, lastError: 'locked' });
  });

  it('asks a thread named again by a recheck only about turns since its debrief, and never asks one that is not a Codex thread', async () => {
    const r = rig();
    r.files.add(SCRIPT);
    r.sessions!.live = [idle(A, 45)];
    r.ranges.set(A, range('m-40', 12, [THREAD, 'not-codex', 'broken']));
    r.store.state!.sessions[A] = { throughMessageUuid: 'm-12', debriefedAt: '2026-09-21T12:00:00.000Z', attempts: 0, lastError: null, attemptedAt: null, attemptedThrough: null };
    r.store.state!.codex = {
      [THREAD]: { parentSessionId: A, cwd: 'd:/work/a', debriefedAt: '2026-09-21T12:00:00.000Z', lastError: null, pending: false, attempts: 0, attemptedAt: null },
      'not-codex': { parentSessionId: A, cwd: 'd:/work/a', debriefedAt: null, lastError: null, pending: false, attempts: 0, attemptedAt: null },
      broken: { parentSessionId: A, cwd: 'd:/work/a', debriefedAt: null, lastError: 'locked', pending: false, attempts: 3, attemptedAt: '2026-09-21T12:00:00.000Z' },
    };
    r.answers.push(answered([]));
    r.codexAnswers.push({ ok: false, reason: 'failed', detail: 'Command failed', exitCode: 3 }, { ok: true, text: JSON.stringify({ friction: [] }) });

    await r.runner.scan();

    expect(r.codex).toEqual([[SCRIPT, THREAD, PROMPT, '2026-09-21T12:00:00.000Z'], [SCRIPT, 'broken', PROMPT, null]]);
    expect(r.store.state?.codex[THREAD]).toMatchObject({ debriefedAt: '2026-09-21T12:00:00.000Z', pending: false });
    expect(r.store.state?.codex.broken).toMatchObject({ debriefedAt: AT, lastError: null, pending: false, attempts: 0 });
    expect(r.store.logs.map((entry) => [entry.provider, entry.sessionId])).toEqual([['claude', A], ['codex', 'broken']]);
  });

  it('asks a thread whose line the state lost only about turns after that line, so it is not paid for twice', async () => {
    const r = rig();
    r.files.add(SCRIPT);
    r.store.state!.codex[THREAD] = { parentSessionId: A, cwd: 'd:/work/a', debriefedAt: '2026-09-21T12:00:00.000Z', lastError: null, pending: true, attempts: 0, attemptedAt: null };
    r.store.logs.push({ ...answeredLine(THREAD), provider: 'codex', parentSessionId: A, throughMessageUuid: null, at: '2026-09-21T13:00:00.000Z' });
    r.codexAnswers.push({ ok: false, reason: 'failed', detail: 'no turn since', exitCode: 3 });

    await r.runner.scan();

    expect(r.codex).toEqual([[SCRIPT, THREAD, PROMPT, '2026-09-21T13:00:00.000Z']]);
    expect(r.store.logs).toHaveLength(1);
    expect(r.store.state?.codex[THREAD]).toMatchObject({ debriefedAt: '2026-09-21T13:00:00.000Z', pending: false });
  });

  it('holds a Codex answer whose line could not be written, and asks nothing more until it is written', async () => {
    const r = rig();
    r.files.add(SCRIPT);
    r.store.state!.codex[THREAD] = { parentSessionId: A, cwd: 'd:/work/a', debriefedAt: null, lastError: null, pending: true, attempts: 0, attemptedAt: null };
    r.store.state!.codex.other = { parentSessionId: A, cwd: 'd:/work/a', debriefedAt: null, lastError: null, pending: true, attempts: 0, attemptedAt: null };
    r.store.failAppend = true;
    r.codexAnswers.push({ ok: true, text: JSON.stringify({ friction: [SANDBOX] }) });

    await r.runner.scan();
    r.clock.now += 10 * MINUTE;
    await r.runner.scan();

    expect(r.codex.map(([, thread]) => thread)).toEqual([THREAD]);
    expect(r.store.state?.codex[THREAD]).toMatchObject({ pending: true });

    r.store.failAppend = false;
    r.codexAnswers.push({ ok: false, reason: 'failed', detail: 'not Codex', exitCode: 3 });
    await r.runner.scan();

    expect(r.codex.map(([, thread]) => thread)).toEqual([THREAD, 'other']);
    expect(r.store.logs).toEqual([expect.objectContaining({ provider: 'codex', sessionId: THREAD, friction: [SANDBOX], at: AT })]);
    expect(r.store.state?.codex[THREAD]).toMatchObject({ debriefedAt: AT, pending: false });
  });

  it('asks no Codex thread while the log cannot be read', async () => {
    const r = rig();
    r.files.add(SCRIPT);
    r.store.state!.codex[THREAD] = { parentSessionId: A, cwd: 'd:/work/a', debriefedAt: null, lastError: null, pending: true, attempts: 0, attemptedAt: null };
    r.store.logUnreadable = true;

    await r.runner.scan();

    expect(r.codex).toEqual([]);
    expect(r.store.state?.codex[THREAD]).toMatchObject({ pending: true, attempts: 0 });
    expect(r.messages).toContain(`${DIR}/log cannot be read, so what was debriefed is unknown; debriefs wait until it can.`);
  });

  it('keeps threads waiting while the Codex command does not exist, and refuses an answer that is not the friction JSON', async () => {
    const r = rig();
    r.sessions!.live = [idle(A, 45)];
    r.ranges.set(A, range('m-12', 12, [THREAD]));
    r.answers.push(answered([]));

    await r.runner.scan();

    expect(r.codex).toEqual([]);
    expect(r.store.state?.codex[THREAD]).toMatchObject({ pending: true, attempts: 0 });

    r.files.add(SCRIPT);
    r.codexAnswers.push({ ok: true, text: 'no friction' });
    await r.runner.scan();

    expect(r.store.logs.filter((entry) => entry.provider === 'codex')).toEqual([]);
    expect(r.store.state?.codex[THREAD]).toMatchObject({ debriefedAt: null, pending: true, attempts: 1, lastError: 'the Codex debrief answer was not the friction JSON: no friction' });
  });
});

describe('configured debrief paths', () => {
  it('uses the default for empty, and the home directory for ~ and a relative path', () => {
    expect(underHome('', 'C:/Users/dev', '.claude/.wip/debrief')).toBe('C:/Users/dev/.claude/.wip/debrief');
    expect(underHome('~/notes/debrief', 'C:/Users/dev', 'x')).toBe('C:/Users/dev/notes/debrief');
    expect(underHome('~\\notes', 'C:/Users/dev', 'x')).toBe('C:/Users/dev/notes');
    expect(underHome('D:\\data\\debrief', 'C:/Users/dev', 'x')).toBe('D:/data/debrief');
    expect(underHome('debrief', '/home/dev', 'x')).toBe('/home/dev/debrief');
  });
});

describe('the debrief files', () => {
  let home: string;
  let dispose: () => void;

  beforeEach(() => ({ home, dispose } = tempHome()));
  afterEach(() => dispose());

  it('reads an absent state as empty and a malformed one as unreadable, and writes state and monthly log lines', () => {
    const dir = join(home, 'debrief');
    const store = makeDebriefStore(dir);

    expect(store.readState()).toEqual({ v: 1, sessions: {}, codex: {}, subagents: {} });

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), '{"v":2}');
    expect(store.readState()).toBeNull();

    const state: DebriefState = { v: 1, sessions: { [A]: { throughMessageUuid: 'm-12', debriefedAt: '2026-09-30T18:04:11.000Z', attempts: 0, lastError: null, attemptedAt: null, attemptedThrough: null } }, codex: {}, subagents: { [`${A}/a1`]: '2026-09-30T18:00:00.000Z' } };
    expect(store.writeState(state)).toBe(true);
    expect(store.readState()).toEqual(state);

    // A state written before subagents were tracked reads with none.
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ v: 1, sessions: {}, codex: {} }));
    expect(store.readState()).toEqual({ v: 1, sessions: {}, codex: {}, subagents: {} });

    const entry = (at: string): DebriefLogEntry => ({
      v: 1, at, provider: 'claude', sessionId: A, parentSessionId: null, cwd: 'd:/work/a', fromMessageUuid: null,
      throughMessageUuid: 'm-12', skills: [], toolCalls: 12, cache: null, friction: [],
    });
    expect(store.appendLog(entry('2026-09-30T18:04:11.000Z'))).toBe(true);
    expect(store.appendLog(entry('2026-09-30T19:00:00.000Z'))).toBe(true);
    expect(store.appendLog(entry('2026-10-01T00:00:01.000Z'))).toBe(true);

    expect(readdirSync(join(dir, 'log')).sort()).toEqual(['2026-09.jsonl', '2026-10.jsonl']);
    expect(readFileSync(join(dir, 'log', '2026-09.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).at)).toEqual(['2026-09-30T18:04:11.000Z', '2026-09-30T19:00:00.000Z']);
  });

  it('reads a state file it cannot open as unreadable, not as empty, and finds a logged range', () => {
    const dir = join(home, 'debrief');
    mkdirSync(join(dir, 'state.json'), { recursive: true });
    const store = makeDebriefStore(dir);

    expect(store.readState()).toBeNull();
    expect(store.logged()).toEqual({ claude: new Map(), codex: new Map() });

    const entry = (provider: 'claude' | 'codex', sessionId: string, through: string | null): DebriefLogEntry => ({
      v: 1, at: '2026-09-30T18:04:11.000Z', provider, sessionId, parentSessionId: null, cwd: 'd:/work/a', fromMessageUuid: null,
      throughMessageUuid: through, skills: null, toolCalls: null, cache: null, friction: [],
    });
    store.appendLog({ ...entry('claude', A, 'm-30'), at: '2026-09-30T19:00:00.000Z' });
    store.appendLog(entry('claude', A, 'm-12'));
    store.appendLog(entry('codex', B, null));
    store.appendLog(entry('claude', B, null));
    writeFileSync(join(dir, 'log', '2026-09.jsonl'), `null\n7\n"${A}"\n{"cut ${A}`, { flag: 'a' });

    const base = { cwd: 'd:/work/a', subagents: [], delegated: [] };
    const first = store.logged();
    expect(first).toEqual({
      claude: new Map([[A, { ...base, throughMessageUuid: 'm-30', at: '2026-09-30T19:00:00.000Z', startedAt: '2026-09-30T19:00:00.000Z' }]]),
      codex: new Map([[B, { ...base, throughMessageUuid: null, at: '2026-09-30T18:04:11.000Z', startedAt: '2026-09-30T18:04:11.000Z' }]]),
    });

    store.appendLog({ ...entry('claude', A, 'm-31'), at: '2026-09-30T19:30:00.000Z', startedAt: '2026-09-30T19:28:00.000Z', subagents: ['a1'], delegated: [THREAD] });
    expect(store.logged()).toMatchObject({ claude: new Map([[A, { ...base, throughMessageUuid: 'm-31', at: '2026-09-30T19:30:00.000Z', startedAt: '2026-09-30T19:28:00.000Z', subagents: ['a1'], delegated: [THREAD] }]]) });

    // A log file that exists but cannot be read leaves the answer unknown.
    rmSync(join(dir, 'log', '2026-09.jsonl'));
    mkdirSync(join(dir, 'log', '2026-09.jsonl'));
    expect(store.logged()).toEqual({ unreadable: true });
  });

  it('reports a write it could not make', () => {
    const blocked = join(home, 'file');
    writeFileSync(blocked, 'not a directory');
    const store = makeDebriefStore(blocked);

    expect(store.writeState({ v: 1, sessions: {}, codex: {}, subagents: {} })).toBe(false);
    expect(store.appendLog({ v: 1, at: '2026-09-30T18:04:11.000Z', provider: 'claude', sessionId: A, parentSessionId: null, cwd: '', fromMessageUuid: null, throughMessageUuid: null, skills: null, toolCalls: null, cache: null, friction: [] })).toBe(false);
  });
});
