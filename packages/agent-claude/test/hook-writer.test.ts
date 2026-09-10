import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOOK_SOURCE } from '../src/hookScript.js';
import { fixture } from './helpers.js';

interface Payload {
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  source?: string;
  reason?: string;
  notification_type?: string;
  agent_id?: string;
  background_tasks?: unknown[];
  cwd?: string;
  prompt?: string;
}

const payloads = fixture('hook-payloads') as Payload[];

let root: string;
let writer: string;
let activity: string;

/** Run the standalone writer with USERPROFILE or HOME redirected to an isolated directory. */
function run(input: string, home = root): { status: number; stdout: string } {
  let stdout = '';
  let status = 0;

  try {
    stdout = execFileSync(process.execPath, [writer], {
      input,
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: home, HOME: home },
      windowsHide: true,
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    status = failure.status ?? 1;
    stdout = failure.stdout ?? '';
  }

  return { status, stdout };
}

const markerFor = (sessionId: string): unknown => JSON.parse(readFileSync(join(activity, `${sessionId}.json`), 'utf8'));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gc-writer-'));
  writer = join(root, 'hook.mjs');
  activity = join(root, '.claude', 'ground-control', 'activity');
  writeFileSync(writer, HOOK_SOURCE);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the activity writer', () => {
  it('transcribes every recorded payload without interpreting it', () => {
    for (const payload of payloads) {
      if (payload.hook_event_name === 'SessionEnd' || payload.agent_id !== undefined) {
        continue;
      }

      const { status, stdout } = run(JSON.stringify(payload));

      expect(status).toBe(0);
      expect(stdout).toBe('');
      expect(markerFor(payload.session_id as string)).toMatchObject({
        v: 1,
        sessionId: payload.session_id,
        event: payload.hook_event_name,
        cwd: payload.cwd ?? null,
        notificationType: payload.notification_type ?? null,
        source: payload.source ?? null,
        toolName: payload.tool_name ?? null,
        reason: payload.reason ?? null,
        backgroundTasks: payload.background_tasks?.length ?? 0,
      });
    }
  });

  /** Preserve prompt time across tool events so running duration does not reset. */
  it('stamps the turn on the prompt and carries it across the events inside the turn', () => {
    run(JSON.stringify({ session_id: 'turning', hook_event_name: 'UserPromptSubmit' }));

    const prompt = markerFor('turning') as { at: number; turnAt: number };

    expect(prompt.turnAt).toBe(prompt.at);

    run(JSON.stringify({ session_id: 'turning', hook_event_name: 'PostToolBatch' }));
    run(JSON.stringify({ session_id: 'turning', hook_event_name: 'PermissionRequest', tool_name: 'Bash' }));
    run(JSON.stringify({ session_id: 'turning', hook_event_name: 'SessionStart', source: 'compact' }));
    run(JSON.stringify({ session_id: 'turning', hook_event_name: 'Stop', background_tasks: [{}] }));

    expect(markerFor('turning')).toMatchObject({ event: 'Stop', turnAt: prompt.turnAt });
  });

  /** Work resumed after a completed turn must start a new duration instead of reusing an earlier turn timestamp. */
  it('ends the stretch on a stop with nothing left in flight, and starts a new one where work resumes', () => {
    run(JSON.stringify({ session_id: 'ending', hook_event_name: 'UserPromptSubmit', prompt: 'recorded' }));

    const first = markerFor('ending') as { turnAt: number };

    run(JSON.stringify({ session_id: 'ending', hook_event_name: 'Stop', background_tasks: [] }));

    expect(markerFor('ending')).toMatchObject({ turnAt: null });

    run(JSON.stringify({ session_id: 'ending', hook_event_name: 'PostToolBatch' }));

    const resumed = markerFor('ending') as { at: number; turnAt: number };

    expect(resumed.turnAt).toBe(resumed.at);
    expect(resumed.turnAt).not.toBe(first.turnAt);
  });

  /**
   * Harness input arrives as UserPromptSubmit. The task-notification prefix was observed in a 2.1.266 print-mode
   * session waiting on a background subagent; all cases here are derived from the CLI's prompt prefixes (M20).
   */
  it.each([
    ['a background subagent result', '<task-notification>\n<task-id>ab95c88fac23a6c88</task-id>\n<status>completed</status>'],
    ['a poll event', '<event kind="repl-eval" at="2026-09-09T00:00:00.000Z">eval #1 settled</event>'],
    ['a system reminder', '<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nrecorded\n</system-reminder>'],
    ['a queued notification', '[SYSTEM NOTIFICATION - NOT USER INPUT]\nExactly 1 notification was queued'],
    ['a scheduled prompt', '[SCHEDULED TASK - AUTOMATED FIRING OF A CONFIGURED PROMPT]\nrecorded'],
    ['an indented notification', '  \n<task-notification>'],
  ])('keeps the stretch when %s arrives as a prompt', (name, prompt) => {
    const id = `harness-${name.replace(/\W+/g, '-')}`;

    run(JSON.stringify({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'recorded' }));

    const typed = markerFor(id) as { turnAt: number };

    run(JSON.stringify({ session_id: id, hook_event_name: 'Stop', background_tasks: [{}] }));
    run(JSON.stringify({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt }));

    expect(markerFor(id)).toMatchObject({ event: 'UserPromptSubmit', turnAt: typed.turnAt });

    run(JSON.stringify({ session_id: id, hook_event_name: 'PostToolBatch' }));

    expect(markerFor(id)).toMatchObject({ turnAt: typed.turnAt });
  });

  it('starts the stretch when harness input wakes a session with no turn in progress', () => {
    run(JSON.stringify({ session_id: 'woken', hook_event_name: 'UserPromptSubmit', prompt: 'recorded' }));
    run(JSON.stringify({ session_id: 'woken', hook_event_name: 'Stop', background_tasks: [] }));
    run(JSON.stringify({ session_id: 'woken', hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>' }));

    const woken = markerFor('woken') as { at: number; turnAt: number };

    expect(woken.turnAt).toBe(woken.at);
  });

  it('restarts the stretch on a typed prompt that merely mentions a harness prefix', () => {
    run(JSON.stringify({ session_id: 'mention', hook_event_name: 'UserPromptSubmit', prompt: 'recorded' }));

    const first = markerFor('mention') as { turnAt: number };

    run(JSON.stringify({ session_id: 'mention', hook_event_name: 'Stop', background_tasks: [{}] }));
    run(JSON.stringify({ session_id: 'mention', hook_event_name: 'UserPromptSubmit', prompt: 'why did <task-notification> reset?' }));

    const second = markerFor('mention') as { at: number; turnAt: number };

    expect(second.turnAt).toBe(second.at);
    expect(second.turnAt).not.toBe(first.turnAt);
  });

  it('ends the stretch on a session start that is not a compact', () => {
    run(JSON.stringify({ session_id: 'restarting', hook_event_name: 'UserPromptSubmit' }));
    run(JSON.stringify({ session_id: 'restarting', hook_event_name: 'SessionStart', source: 'resume' }));

    expect(markerFor('restarting')).toMatchObject({ turnAt: null });
  });

  /** When hooks are installed mid-turn, start timing from the first observed event. */
  it('starts the stretch at the first event of a session it has no marker for', () => {
    run(JSON.stringify({ session_id: 'heartbeat-first', hook_event_name: 'PostToolBatch' }));

    const marker = markerFor('heartbeat-first') as { at: number; turnAt: number };

    expect(marker.turnAt).toBe(marker.at);
  });

  /** Ignore subagent events using the parent ID so they cannot overwrite a parent waiting for input (R6). */
  it('writes nothing for a hook that fired inside a subagent', () => {
    const subagent = payloads.filter((payload) => payload.agent_id !== undefined);

    expect(subagent.length).toBeGreaterThan(0);

    for (const payload of subagent) {
      const parent = { ...payload, session_id: 'parent-1' };

      run(JSON.stringify({ session_id: 'parent-1', hook_event_name: 'PermissionRequest' }));
      run(JSON.stringify(parent));

      expect(markerFor('parent-1')).toMatchObject({ event: 'PermissionRequest' });
    }
  });

  /** Older asynchronous events must not overwrite newer observations. */
  it('refuses to overwrite a marker written by a newer event', () => {
    run(JSON.stringify({ session_id: 'racing', hook_event_name: 'Stop' }));

    const marker = join(activity, 'racing.json');
    const held = JSON.parse(readFileSync(marker, 'utf8')) as { at: number };

    writeFileSync(marker, JSON.stringify({ ...held, at: Date.now() + 60_000, event: 'PermissionRequest' }));
    run(JSON.stringify({ session_id: 'racing', hook_event_name: 'PostToolBatch' }));

    expect(markerFor('racing')).toMatchObject({ event: 'PermissionRequest' });
  });

  /** Derive pending background-task counts because recorded Stop payloads all had zero tasks. */
  it('records how much background work a stop left in flight', () => {
    const stop = payloads.find((payload) => payload.hook_event_name === 'Stop');

    expect(stop?.background_tasks).toEqual([]);

    run(JSON.stringify({ ...stop, session_id: 'bg-1', background_tasks: [{}, {}] }));
    expect(markerFor('bg-1')).toMatchObject({ event: 'Stop', backgroundTasks: 2 });
  });

  it('removes the marker when the session ends, and tolerates there being none', () => {
    run(JSON.stringify({ session_id: 'ending', hook_event_name: 'Stop' }));
    expect(existsSync(join(activity, 'ending.json'))).toBe(true);

    expect(run(JSON.stringify({ session_id: 'ending', hook_event_name: 'SessionEnd', reason: 'clear' })).status).toBe(0);
    expect(existsSync(join(activity, 'ending.json'))).toBe(false);

    expect(run(JSON.stringify({ session_id: 'never-was', hook_event_name: 'SessionEnd' })).status).toBe(0);
  });

  /**
   * Check valid JSON and absence of leftover temporary files. This synchronous test does not establish rename
   * atomicity.
   */
  it('leaves the directory holding only whole markers', () => {
    run(JSON.stringify({ session_id: 'clean', hook_event_name: 'Stop' }));

    expect(readdirSync(activity).every((name) => name.endsWith('.json'))).toBe(true);
    expect(markerFor('clean')).toMatchObject({ sessionId: 'clean' });
  });

  /**
   * Writer failures must produce no stdout and exit 0; hook output can deny permissions, block prompts, or
   * inject context.
   */
  it.each([
    ['nothing at all', ''],
    ['a payload that is not JSON', '{ not json'],
    ['a payload with no session id', '{"hook_event_name":"Stop"}'],
    ['a session id that is not a string', '{"session_id":7,"hook_event_name":"Stop"}'],
    ['a session id that could escape the directory', '{"session_id":"../../escaped","hook_event_name":"Stop"}'],
  ])('exits 0 and says nothing when handed %s', (_case, input) => {
    const { status, stdout } = run(input);

    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('writes nothing outside its own directory for a session id that could escape it', () => {
    run('{"session_id":"../../escaped","hook_event_name":"Stop"}');

    expect(existsSync(join(root, 'escaped.json'))).toBe(false);
  });

  it('writes markers under the state directory a pointer names, and ignores a relative pointer', () => {
    const pointed = mkdtempSync(join(tmpdir(), 'gc-pointed-'));
    const elsewhere = join(pointed, 'elsewhere');

    mkdirSync(join(pointed, '.claude', 'ground-control'), { recursive: true });
    writeFileSync(join(pointed, '.claude', 'ground-control', 'state-dir.json'), JSON.stringify({ stateDir: elsewhere }));
    run('{"session_id":"moved","hook_event_name":"Stop"}', pointed);

    expect(existsSync(join(elsewhere, 'activity', 'moved.json'))).toBe(true);
    expect(existsSync(join(pointed, '.claude', 'ground-control', 'activity', 'moved.json'))).toBe(false);

    writeFileSync(join(pointed, '.claude', 'ground-control', 'state-dir.json'), JSON.stringify({ stateDir: 'relative/state' }));
    run('{"session_id":"stayed","hook_event_name":"Stop"}', pointed);

    expect(existsSync(join(pointed, '.claude', 'ground-control', 'activity', 'stayed.json'))).toBe(true);

    rmSync(pointed, { recursive: true, force: true });
  });

  it('exits 0 when the marker cannot be written', () => {
    const blocked = mkdtempSync(join(tmpdir(), 'gc-blocked-'));

    // A file where the activity directory needs to be: mkdir then fails, which is the unwritable case on both OSes.
    mkdirSync(join(blocked, '.claude', 'ground-control'), { recursive: true });
    writeFileSync(join(blocked, '.claude', 'ground-control', 'activity'), 'not a directory');

    const { status, stdout } = run('{"session_id":"blocked","hook_event_name":"Stop"}', blocked);

    expect(status).toBe(0);
    expect(stdout).toBe('');

    rmSync(blocked, { recursive: true, force: true });
  });
});
