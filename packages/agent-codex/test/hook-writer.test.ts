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
  profileRoot: string;
  model: string | null;
  permissionMode: string | null;
  source: string | null;
  toolName: string | null;
  reason: string | null;
}

let root: string;
let writer: string;
let activity: string;

/** Run the standalone writer with USERPROFILE or HOME redirected to an isolated directory. */
function run(input: HookPayload | string, home = root): number {
  try {
    execFileSync(process.execPath, [writer], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: home, HOME: home, CODEX_HOME: join(home, 'selected-profile') },
      windowsHide: true,
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
    // Windows can retain a handle to the node copy after exit; leave it in OS temporary storage.
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
    expect(marker.profileRoot).toBe(join(root, 'selected-profile'));

    expect(marker.v).toBe(HOOK_MARKER_VERSION);
    expect(marker.sessionId).toBe(SESSION);
    expect(marker.event).toBe('SessionStart');
    expect(marker.cwd).toBe(sent.cwd);
    expect(marker.transcriptPath).toBe(sent.transcript_path);
    expect(marker.model).toBe(sent.model);
    expect(marker.permissionMode).toBe(sent.permission_mode);
    expect(marker.source).toBe('startup');
    // Startup has no turn timestamp.
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

    // Preserve prompt time for the same turn ID.
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

  it('removes the marker on SessionEnd', () => {
    run(payload('SessionStart'));

    expect(markers()).toEqual([`${SESSION}.json`]);

    run(payload('SessionEnd'));

    expect(markers()).toEqual([]);
  });

  /** An asynchronous Stop after synchronous SessionEnd must not recreate the removed marker (R9, M41). */
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
    // Concurrent SessionStart and first-prompt events must preserve the prompt phase (M40).
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

  it('replaces incompatible marker versions', () => {
    mkdirSync(activity, { recursive: true });
    writeFileSync(
      join(activity, `${SESSION}.json`),
      JSON.stringify({ v: HOOK_MARKER_VERSION + 1, sessionId: SESSION, pid: 4242, startedAt: 1, at: 1 }),
    );

    run(payload('UserPromptSubmit'));

    // Do not carry fields forward from incompatible versions.
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

    it('replaces far-future markers after backward clock changes', () => {
      mkdirSync(activity, { recursive: true });
      writeFileSync(join(activity, `${SESSION}.json`), JSON.stringify(ahead(Date.now() + 600_000)));

      run(payload('Stop'));

      // Far-future markers must remain replaceable after clock changes.
      expect(markerFor(SESSION).event).toBe('Stop');
    });
  });
});

describe('Codex ancestor PID lookup', () => {
  /**
   * Use a node copy named Codex as the hook ancestor. Lookup matches the process name through the shell, not
   * binary identity (M40).
   */
  function underCodex(sent: HookPayload): void {
    const shim = join(root, process.platform === 'win32' ? 'codex-shim.exe' : 'codex-shim');

    if (!existsSync(shim)) {
      copyFileSync(process.execPath, shim);
      writeFileSync(
        join(root, 'relay.mjs'),
        "import { execFileSync } from 'node:child_process';\n" +
          "execFileSync(process.argv[2], [process.argv[3]], { input: process.argv[4], windowsHide: true });\n",
      );
    }

    execFileSync(shim, [join(root, 'relay.mjs'), process.execPath, writer, JSON.stringify(sent)], {
      env: { ...process.env, USERPROFILE: root, HOME: root, CODEX_HOME: join(root, 'selected-profile') },
      encoding: 'utf8',
      windowsHide: true,
    });
  }

  it('claims nothing when nothing in the parent chain is Codex', () => {
    run(payload('SessionStart'));

    // Return no PID under Vitest without a Codex ancestor; the roster then reports unknown liveness.
    expect(markerFor(SESSION).pid).toBeNull();
  });

  it('finds the Codex process the hook was spawned under, and copies it forward', () => {
    underCodex(payload('SessionStart'));

    const walked = markerFor(SESSION).pid;

    expect(walked).not.toBeNull();

    // Later events preserve the resolved PID without repeating ancestry lookup.
    run(payload('PostToolUse'));

    expect(markerFor(SESSION).pid).toBe(walked);
  });

  /** Limit ancestry retries to marker-creating events; tool hooks must not repeatedly spawn failing lookups. */
  it('does not walk on a tool call, however unproven the session it belongs to is', () => {
    run(payload('UserPromptSubmit'));

    expect(markerFor(SESSION).pid).toBeNull();

    // A lookup would succeed under this Codex-named parent, so retaining null proves no retry occurred.
    underCodex(payload('PostToolUse'));

    expect(markerFor(SESSION).pid).toBeNull();
    expect(markerFor(SESSION).event).toBe('PostToolUse');
  });
});

describe('two writers at once', () => {
  it('leaves one marker and no temporary file behind', async () => {
    // Measured in M40: two hooks landed in the same millisecond and one rename lost its event on Windows.
    const spawn = promisify(execFile);
    const start = (sent: HookPayload) => {
      const running = spawn(process.execPath, [writer], {
        env: { ...process.env, USERPROFILE: root, HOME: root, CODEX_HOME: join(root, 'selected-profile') },
        windowsHide: true,
      });
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

    // Concurrent writes must leave one valid marker and no temporary files.
    expect(markers()).toEqual([`${SESSION}.json`]);
    // At least one concurrent event must replace the original prompt marker.
    expect(['PreToolUse', 'PostToolUse', 'Stop']).toContain(after.event);
    // Preserve session metadata in the winning write.
    expect(after.startedAt).toBe(opened.startedAt);
    expect(after.pid).toBe(opened.pid);
  });
});

describe('the recorded payloads', () => {
  it('preserves captured event order for a session', () => {
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
