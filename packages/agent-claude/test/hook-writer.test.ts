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
}

const payloads = fixture('hook-payloads') as Payload[];

let root: string;
let writer: string;
let activity: string;

/**
 * The writer only ever runs as a child process, so the only way to know it works is to run it. `homedir()` reads
 * USERPROFILE on Windows and HOME elsewhere, which is what keeps this off the real `~/.claude`.
 */
function run(input: string, home = root): { status: number; stdout: string } {
  let stdout = '';
  let status = 0;

  try {
    stdout = execFileSync(process.execPath, [writer], {
      input,
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: home, HOME: home },
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

  /**
   * The duration on a running card counts the turn, so the prompt's own time has to survive every event inside the
   * turn — a heartbeat lands on every tool batch, and an event-time anchor holds the card at zero all turn.
   */
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

  /**
   * A background wake and a cron fire tool events and no prompt, so a stamp that outlived its stretch would count them
   * from the prompt before them — hours of nothing, on work a second old.
   */
  it.each([
    ['a stop with nothing left in flight', { hook_event_name: 'Stop', background_tasks: [] }],
    ['an agent_completed notification', { hook_event_name: 'Notification', notification_type: 'agent_completed' }],
  ])('ends the stretch on %s, and starts a new one where work resumes', (_case, ending) => {
    const id = `ending-${ending.hook_event_name}`;

    run(JSON.stringify({ session_id: id, hook_event_name: 'UserPromptSubmit' }));

    const first = markerFor(id) as { turnAt: number };

    run(JSON.stringify({ ...ending, session_id: id }));

    expect(markerFor(id)).toMatchObject({ turnAt: null });

    run(JSON.stringify({ session_id: id, hook_event_name: 'PostToolBatch' }));

    const resumed = markerFor(id) as { at: number; turnAt: number };

    expect(resumed.turnAt).toBe(resumed.at);
    expect(resumed.turnAt).not.toBe(first.turnAt);
  });

  it('ends the stretch on a session start that is not a compact', () => {
    run(JSON.stringify({ session_id: 'restarting', hook_event_name: 'UserPromptSubmit' }));
    run(JSON.stringify({ session_id: 'restarting', hook_event_name: 'SessionStart', source: 'resume' }));

    expect(markerFor('restarting')).toMatchObject({ turnAt: null });
  });

  /**
   * The hooks are installed into a machine already at work, so the first event a session reports is routinely a
   * heartbeat mid-turn. Anchoring the stretch there is what keeps that card off zero until its next prompt.
   */
  it('starts the stretch at the first event of a session it has no marker for', () => {
    run(JSON.stringify({ session_id: 'heartbeat-first', hook_event_name: 'PostToolBatch' }));

    const marker = markerFor('heartbeat-first') as { at: number; turnAt: number };

    expect(marker.turnAt).toBe(marker.at);
  });

  /**
   * A subagent's hooks carry the parent's session id, so its work would land on the parent — clearing a `waiting` on
   * a session actually parked on a prompt, which is the one case R6 exists for.
   */
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

  /** Hooks run async, so two race at a turn boundary and the loser must not overwrite what the winner observed. */
  it('refuses to overwrite a marker written by a newer event', () => {
    run(JSON.stringify({ session_id: 'racing', hook_event_name: 'Stop' }));

    const marker = join(activity, 'racing.json');
    const held = JSON.parse(readFileSync(marker, 'utf8')) as { at: number };

    writeFileSync(marker, JSON.stringify({ ...held, at: Date.now() + 60_000, event: 'PermissionRequest' }));
    run(JSON.stringify({ session_id: 'racing', hook_event_name: 'PostToolBatch' }));

    expect(markerFor('racing')).toMatchObject({ event: 'PermissionRequest' });
  });

  /**
   * Every recorded Stop happened to have nothing in flight, and a session with background work cannot be induced on
   * demand, so the count is derived here from a recorded payload rather than saved as one.
   */
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
   * Not proof of atomicity — a synchronous test cannot observe a rename. What it does catch is residue: a temp file
   * left in the directory a reader polls, and a marker whose content is not whole JSON.
   */
  it('leaves the directory holding only whole markers', () => {
    run(JSON.stringify({ session_id: 'clean', hook_event_name: 'Stop' }));

    expect(readdirSync(activity).every((name) => name.endsWith('.json'))).toBe(true);
    expect(markerFor('clean')).toMatchObject({ sessionId: 'clean' });
  });

  /**
   * Exit 2 is *deny* on PermissionRequest and *block* on UserPromptSubmit, and stdout is a decision on the one and
   * injected context on the other — so a writer that cannot do its job must be silent and succeed.
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
