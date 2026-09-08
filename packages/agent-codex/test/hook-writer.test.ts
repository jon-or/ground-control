import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_MARKER_VERSION, HOOK_SOURCE } from '../src/hookScript.js';
import { payload, payloads } from './helpers.js';
import type { HookPayload } from './helpers.js';


interface Marker {
  v: number;
  sessionId: string;
  event: string | null;
  at: number;
  turnAt: number | null;
  turnId: string | null;
  pid: number | null;
  startedAt: number;
  cwd: string | null;
  transcriptPath: string | null;
  model: string | null;
  permissionMode: string | null;
  source: string | null;
  toolName: string | null;
  reason: string | null;
}

let root: string;
let writer: string;
let activity: string;

/**
 * The writer only ever runs as a child process, so the only way to know it works is to run it. `homedir()` reads
 * USERPROFILE on Windows and HOME elsewhere, which is what keeps this off the developer's real home.
 */
function run(input: HookPayload | string, home = root): number {
  try {
    execFileSync(process.execPath, [writer], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: home, HOME: home },
    });

    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

const markerFor = (sessionId: string): Marker =>
  JSON.parse(readFileSync(join(activity, `${sessionId}.json`), 'utf8')) as Marker;

const markers = (): string[] => (existsSync(activity) ? readdirSync(activity) : []);

const SESSION = payload('SessionStart').session_id!;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gc-codex-writer-'));
  writer = join(root, 'codex-hook.mjs');
  activity = join(root, '.claude', 'ground-control', 'codex-activity');
  writeFileSync(writer, HOOK_SOURCE);
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows keeps a handle on a copy of node it has just run. The temp directory is the OS's to reap.
  }
});

beforeEach(() => {
  rmSync(activity, { recursive: true, force: true });
});

describe('the Codex activity writer', () => {
  it('transcribes a recorded session start into a marker named for the session', () => {
    const sent = payload('SessionStart');

    expect(run(sent)).toBe(0);

    const marker = markerFor(SESSION);

    expect(marker.v).toBe(HOOK_MARKER_VERSION);
    expect(marker.sessionId).toBe(SESSION);
    expect(marker.event).toBe('SessionStart');
    expect(marker.cwd).toBe(sent.cwd);
    expect(marker.transcriptPath).toBe(sent.transcript_path);
    expect(marker.model).toBe(sent.model);
    expect(marker.permissionMode).toBe(sent.permission_mode);
    expect(marker.source).toBe('startup');
    // No turn is in flight at startup, so nothing a running card would count from.
    expect(marker.turnId).toBeNull();
    expect(marker.turnAt).toBeNull();
  });

  it('holds the start time and the turn across the events of one turn', () => {
    run(payload('SessionStart'));
    const first = markerFor(SESSION);

    run(payload('UserPromptSubmit'));
    const prompted = markerFor(SESSION);

    expect(prompted.startedAt).toBe(first.startedAt);
    expect(prompted.turnId).toBe(payload('UserPromptSubmit').turn_id);
    expect(prompted.turnAt).not.toBeNull();

    run(payload('PostToolUse'));
    const later = markerFor(SESSION);

    // The same turn id, so the stretch a running card counts is still the one the prompt opened.
    expect(later.turnAt).toBe(prompted.turnAt);
    expect(later.event).toBe('PostToolUse');
    expect(later.toolName).toBe('Bash');
  });

  it('starts the count again on a turn the marker has not seen', () => {
    run(payload('UserPromptSubmit'));
    const before = markerFor(SESSION);

    run({ ...payload('UserPromptSubmit'), turn_id: 'a-second-turn' });
    const after = markerFor(SESSION);

    expect(after.turnId).toBe('a-second-turn');
    expect(after.turnAt).not.toBe(before.turnAt);
  });

  it('removes the marker on SessionEnd, which is how a session leaves the board', () => {
    run(payload('SessionStart'));

    expect(markers()).toEqual([`${SESSION}.json`]);

    run(payload('SessionEnd'));

    expect(markers()).toEqual([]);
  });

  /**
   * The resurrection R9 forbids: `Stop` is async and `SessionEnd` is synchronous (`docs/mechanics.md` §41), so a
   * `Stop` still in flight when the session ended would otherwise put a card back that nothing ever clears.
   */
  it('refuses to put a marker back for an event that arrives after the session ended', () => {
    run(payload('SessionStart'));
    run(payload('SessionEnd'));

    for (const event of ['Stop', 'PostToolUse', 'PermissionRequest'] as const) {
      run(payload(event));
    }

    expect(markers()).toEqual([]);
  });

  it('creates a marker for a session it has never seen only at its start or its first prompt', () => {
    run(payload('PostToolUse'));

    expect(markers()).toEqual([]);

    run(payload('UserPromptSubmit'));

    expect(markers()).toEqual([`${SESSION}.json`]);
  });

  it('leaves the marker a later event wrote in the same millisecond alone', () => {
    // Measured in §40: a session's start and its first prompt land together, and the start claims no phase — so the
    // start winning the rename would cost the card its phase for the whole first turn.
    run(payload('UserPromptSubmit'));
    run(payload('SessionStart'));

    expect(markerFor(SESSION).event).toBe('UserPromptSubmit');
  });

  it('writes nothing for a session id that would escape the activity directory', () => {
    run(payload('SessionStart'));
    run({ ...payload('SessionStart'), session_id: '../escaped' });

    expect(existsSync(join(root, '.claude', 'ground-control', 'escaped.json'))).toBe(false);
    expect(markers()).toEqual([`${SESSION}.json`]);
  });

  it('exits zero on input that is not JSON, because a hook that fails must not veto the work', () => {
    run(payload('SessionStart'));

    expect(run('not json at all')).toBe(0);
    expect(markers()).toEqual([`${SESSION}.json`]);
    expect(markerFor(SESSION).event).toBe('SessionStart');
  });

  it('replaces a marker from a version whose fields were redefined rather than reading it', () => {
    mkdirSync(activity, { recursive: true });
    writeFileSync(
      join(activity, `${SESSION}.json`),
      JSON.stringify({ v: HOOK_MARKER_VERSION + 1, sessionId: SESSION, pid: 4242, startedAt: 1, at: 1 }),
    );

    run(payload('UserPromptSubmit'));

    // Nothing of the other version's is carried forward: its fields may mean something else.
    expect(markerFor(SESSION).v).toBe(HOOK_MARKER_VERSION);
    expect(markerFor(SESSION).pid).not.toBe(4242);
  });

  describe('the guard on a marker written ahead of this clock', () => {
    const ahead = (at: number) => ({
      v: HOOK_MARKER_VERSION,
      sessionId: SESSION,
      event: 'PostToolUse',
      at,
      turnAt: null,
      turnId: null,
      pid: 4242,
      startedAt: Date.now(),
      cwd: '/work',
      transcriptPath: null,
      model: null,
      permissionMode: null,
      source: null,
      toolName: null,
      reason: null,
    });

    it('stands off a marker a concurrent writer wrote a moment ahead of it', () => {
      mkdirSync(activity, { recursive: true });
      writeFileSync(join(activity, `${SESSION}.json`), JSON.stringify(ahead(Date.now() + 30_000)));

      run(payload('Stop'));

      expect(markerFor(SESSION).event).toBe('PostToolUse');
    });

    it('replaces one further ahead than a race could put it, which is a clock that stepped back', () => {
      mkdirSync(activity, { recursive: true });
      writeFileSync(join(activity, `${SESSION}.json`), JSON.stringify(ahead(Date.now() + 600_000)));

      run(payload('Stop'));

      // Without the upper bound a marker from a forward clock step would wedge the session off the board for good.
      expect(markerFor(SESSION).event).toBe('Stop');
    });
  });
});

describe('the pid the writer walks to', () => {
  /**
   * Runs the writer under a process named for Codex, which is what the walk looks for: Codex spawns a command hook
   * through a shell, so its own process is up the chain rather than named by any environment variable (§40). A copy
   * of node is that process here — the walk matches a process name, not a binary.
   */
  function underCodex(sent: HookPayload): void {
    const shim = join(root, process.platform === 'win32' ? 'codex-shim.exe' : 'codex-shim');

    if (!existsSync(shim)) {
      copyFileSync(process.execPath, shim);
      writeFileSync(
        join(root, 'relay.mjs'),
        "import { execFileSync } from 'node:child_process';\n" +
          "execFileSync(process.argv[2], [process.argv[3]], { input: process.argv[4] });\n",
      );
    }

    execFileSync(shim, [join(root, 'relay.mjs'), process.execPath, writer, JSON.stringify(sent)], {
      env: { ...process.env, USERPROFILE: root, HOME: root },
      encoding: 'utf8',
    });
  }

  it('claims nothing when nothing in the parent chain is Codex', () => {
    run(payload('SessionStart'));

    // The chain here is vitest, and a walk that finds nothing must claim nothing: the roster then reports a session
    // it cannot prove alive rather than showing one that may have died.
    expect(markerFor(SESSION).pid).toBeNull();
  });

  it('finds the Codex process the hook was spawned under, and copies it forward', () => {
    underCodex(payload('SessionStart'));

    const walked = markerFor(SESSION).pid;

    expect(walked).not.toBeNull();

    // And the walk is not paid again: a later event copies the pid the creating event resolved.
    run(payload('PostToolUse'));

    expect(markerFor(SESSION).pid).toBe(walked);
  });

  /**
   * The walk costs a process spawn, and every tool call fires two hooks. A session whose start resolved no pid must
   * not make each of them pay for a walk that will keep failing, so only an event that may create a marker walks.
   */
  it('does not walk on a tool call, however unproven the session it belongs to is', () => {
    run(payload('UserPromptSubmit'));

    expect(markerFor(SESSION).pid).toBeNull();

    // Spawned under the same Codex-named process the positive case walks to, so a walk here would find it.
    underCodex(payload('PostToolUse'));

    expect(markerFor(SESSION).pid).toBeNull();
    expect(markerFor(SESSION).event).toBe('PostToolUse');
  });
});

describe('two writers at once', () => {
  it('leaves one marker and no temporary file behind', async () => {
    // Measured in §40: two hooks landed in the same millisecond and one rename lost its event on Windows.
    const spawn = promisify(execFile);
    const start = (sent: HookPayload) => {
      const running = spawn(process.execPath, [writer], { env: { ...process.env, USERPROFILE: root, HOME: root } });
      running.child.stdin?.end(JSON.stringify(sent));

      return running;
    };

    run(payload('UserPromptSubmit'));
    const opened = markerFor(SESSION);

    await Promise.all([
      start({ ...payload('PostToolUse'), turn_id: 'turn-a' }),
      start({ ...payload('PreToolUse'), turn_id: 'turn-b' }),
      start(payload('Stop')),
    ]);

    const after = markerFor(SESSION);

    // One marker, readable, and no temporary file: a rename that lost its race must clean up after itself.
    expect(markers()).toEqual([`${SESSION}.json`]);
    // One of the three landed rather than every one of them standing off, which would leave the prompt's own event.
    expect(['PreToolUse', 'PostToolUse', 'Stop']).toContain(after.event);
    // And whichever landed carried the session forward rather than writing a marker of its own from nothing.
    expect(after.startedAt).toBe(opened.startedAt);
    expect(after.pid).toBe(opened.pid);
  });
});

describe('the recorded payloads', () => {
  it('carries one session events, in the order Codex fired them', () => {
    expect(payloads.map((sent) => sent.hook_event_name)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PermissionRequest',
      'PostToolUse',
      'Stop',
      'SessionEnd',
    ]);
    expect(new Set(payloads.map((sent) => sent.session_id)).size).toBe(1);
  });
});
