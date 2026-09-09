import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { groundControlDirOf } from '@ground-control/core';
import {
  BACKUPS_KEPT,
  MARKER_MAX_AGE_MS,
  TEMP_MAX_AGE_MS,
  activityNotice,
  backupsToDelete,
  markerIsOrphaned,
  pruneMarkers,
  syncActivity,
  tempIsOrphaned,
  uninstallActivity,
} from '../src/activityInstall.js';
import { installLockPathOf } from '../src/paths.js';
import { fakeAgent, fakeSignal, tempHome } from './helpers.js';

let home: string;
let dispose: () => void;

beforeEach(() => {
  ({ home, dispose } = tempHome());
  mkdirSync(`${home}/.fake`, { recursive: true });
});

afterEach(() => dispose());

const written = { kind: 'write', text: '{"hooks":"installed"}', added: 3, removed: 0 } as const;

describe('syncActivity', () => {
  it('writes what the adapter planned, and creates the directory the watcher reads', () => {
    const signal = fakeSignal(written);
    const state = syncActivity([fakeAgent('fake', signal)], 'install', home);

    expect(state).toMatchObject({ wanted: 'install', plan: 'write', added: 3, failure: null });
    expect(readFileSync(signal.settingsPath(home), 'utf8')).toBe(written.text);
    expect(existsSync(signal.watchDir(home))).toBe(true);
  });

  it('leaves an agent the configuration does not name completely alone', () => {
    const configured = fakeSignal(written, 'fake');
    const other = fakeSignal(written, 'other');
    mkdirSync(`${home}/.other`, { recursive: true });

    const state = syncActivity(
      [fakeAgent('fake', configured), fakeAgent('other', other)],
      'install',
      home,
      false,
      new Set(['fake']),
    );

    expect(configured.planned).toEqual([{ settingsText: null, wanted: 'install' }]);
    // R30: writing into the settings of a CLI the developer never asked the board to read would be the board's own
    // doing — and taking entries out would make one typo in the agents list strip a working agent's hooks.
    expect(other.planned).toEqual([]);
    expect(existsSync(other.settingsPath(home))).toBe(false);
    expect(existsSync(other.watchDir(home))).toBe(false);
    expect(existsSync(other.writer!.path(home))).toBe(false);
    expect(state).toMatchObject({ wanted: 'install', plan: 'write', added: written.added });
  });

  it('reaches every agent when no ids are given, which is what a removal and an uninstall rely on', () => {
    const configured = fakeSignal(written, 'fake');
    const other = fakeSignal(written, 'other');
    mkdirSync(`${home}/.other`, { recursive: true });

    syncActivity([fakeAgent('fake', configured), fakeAgent('other', other)], 'remove', home);

    expect(configured.planned).toEqual([{ settingsText: null, wanted: 'remove' }]);
    expect(other.planned).toEqual([{ settingsText: null, wanted: 'remove' }]);
  });

  it('keeps each agent backups under its own name, so a restore knows which file it holds', () => {
    const signal = fakeSignal(written, 'fake');
    writeFileSync(signal.settingsPath(home), '{"theme":"dark"}');

    syncActivity([fakeAgent('fake', signal)], 'install', home);

    expect(readdirSync(groundControlDirOf(home)).filter((n) => n.startsWith('settings-backup-fake-'))).toHaveLength(1);
  });

  it('hands the adapter the settings text rather than deciding anything itself', () => {
    const signal = fakeSignal(written);
    writeFileSync(signal.settingsPath(home), '{"theme":"dark"}');

    syncActivity([fakeAgent('fake', signal)], 'install', home);

    expect(signal.planned).toEqual([{ settingsText: '{"theme":"dark"}', wanted: 'install' }]);
  });

  it('puts the writer where the adapter said, and rewrites it only when the bytes differ', () => {
    const signal = fakeSignal(written);
    syncActivity([fakeAgent('fake', signal)], 'install', home);

    const path = signal.writer!.path(home);
    expect(readFileSync(path, 'utf8')).toBe(signal.writer!.source);

    writeFileSync(path, signal.writer!.source);
    const before = readFileSync(path, 'utf8');
    syncActivity([fakeAgent('fake', signal)], 'install', home);

    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('backs the settings file up before it writes over one that was already there', () => {
    const signal = fakeSignal(written);
    writeFileSync(signal.settingsPath(home), '{"theme":"dark"}');

    syncActivity([fakeAgent('fake', signal)], 'install', home);

    const backups = readdirSync(groundControlDirOf(home)).filter((n) => n.startsWith('settings-backup-'));

    expect(backups).toHaveLength(1);
    expect(readFileSync(`${groundControlDirOf(home)}/${backups[0]}`, 'utf8')).toBe('{"theme":"dark"}');
  });

  it('takes no backup of a settings file that did not exist, because there is nothing to lose', () => {
    syncActivity([fakeAgent('fake', fakeSignal(written))], 'install', home);

    expect(readdirSync(groundControlDirOf(home)).filter((n) => n.startsWith('settings-backup-'))).toEqual([]);
  });

  it('writes nothing and claims nothing when the adapter says it is already in place', () => {
    const signal = fakeSignal({ kind: 'up-to-date' });
    const state = syncActivity([fakeAgent('fake', signal)], 'install', home);

    expect(state).toMatchObject({ plan: 'up-to-date', added: 0, failure: null });
    expect(existsSync(signal.settingsPath(home))).toBe(false);
  });

  it('reports the adapter refusal in the adapter own words, naming which agent refused', () => {
    const signal = fakeSignal({ kind: 'refuse', reason: 'the file is not JSON', remedy: 'fix it, then reopen' });
    const state = syncActivity([fakeAgent('fake', signal)], 'install', home);

    expect(state.plan).toBe('refuse');
    expect(state.failure).toMatchObject({
      subject: 'fake',
      kind: 'activity-refused',
      message: 'the file is not JSON',
      remedy: 'fix it, then reopen',
    });
    expect(existsSync(signal.settingsPath(home))).toBe(false);
  });

  /**
   * Two agents are installed in one pass, and the second one refusing must not undo the first: a board with Codex
   * misconfigured would otherwise lose Claude's phases too. The refusal names the agent that refused, not the pass.
   */
  it('keeps what the first agent wrote when a later one refuses', () => {
    const first = fakeSignal(written, 'fake');
    const second = fakeSignal({ kind: 'refuse', reason: 'the file is not JSON', remedy: 'fix it, then reopen' }, 'other');
    mkdirSync(`${home}/.other`, { recursive: true });

    const state = syncActivity([fakeAgent('fake', first), fakeAgent('other', second)], 'install', home);

    expect(state).toMatchObject({ plan: 'refuse', added: 3, failure: { subject: 'other' } });
    expect(readFileSync(first.settingsPath(home), 'utf8')).toBe(written.text);
    expect(existsSync(second.settingsPath(home))).toBe(false);
  });

  it('claims nothing at all while another process holds the install lock', () => {
    mkdirSync(groundControlDirOf(home), { recursive: true });
    writeFileSync(installLockPathOf(home), 'another-process');

    const signal = fakeSignal(written);
    const state = syncActivity([fakeAgent('fake', signal)], 'install', home);

    expect(state).toMatchObject({ plan: 'busy', added: 0, failure: null });
    expect(signal.planned).toEqual([]);
  });

  it('gives the lock back, so the next run is not refused by its own leftovers', () => {
    syncActivity([fakeAgent('fake', fakeSignal(written))], 'install', home);

    expect(existsSync(installLockPathOf(home))).toBe(false);
  });

  it('does nothing for agents that offer no signal at all', () => {
    const state = syncActivity([fakeAgent('quiet')], 'install', home);

    expect(state).toMatchObject({ plan: 'up-to-date', added: 0, failure: null });
    expect(readdirSync(home)).toEqual(['.fake']);
  });

  /**
   * The writer stays: a session that already loaded the old settings goes on spawning it (R34). So does the
   * directory: live sessions write into it, and one anything still holds open after a delete keeps its name and
   * refuses every operation on it, the next install's own create included (`mechanics.md` M23).
   */
  it('empties the markers and the entries, and leaves the directory and the writer behind', () => {
    const signal = fakeSignal(written);
    syncActivity([fakeAgent('fake', signal)], 'install', home);
    writeFileSync(`${signal.watchDir(home)}/a1b2c3d4.json`, '{"phase":"working"}');

    const state = uninstallActivity([fakeAgent('fake', signal)], home);

    expect(state).toMatchObject({ wanted: 'remove', plan: 'write' });
    expect(existsSync(signal.watchDir(home))).toBe(true);
    expect(readdirSync(signal.watchDir(home))).toEqual([]);
    expect(existsSync(signal.writer!.path(home))).toBe(true);
  });

  /** Turning the signal back on writes into the directory that is already there, rather than creating it again. */
  it('installs again over a directory a removal left in place', () => {
    const signal = fakeSignal(written);
    syncActivity([fakeAgent('fake', signal)], 'install', home);
    uninstallActivity([fakeAgent('fake', signal)], home);

    const state = syncActivity([fakeAgent('fake', signal)], 'install', home);

    expect(state.failure).toBeNull();
    expect(existsSync(signal.watchDir(home))).toBe(true);
  });

  /**
   * `vscode:uninstall` fires once and is never retried, so deferring to a lock — a live window's, or one a crash left
   * behind inside the stale window — leaves entries naming a writer nobody maintains firing forever (R34).
   */
  it('takes the signal away even while something else holds the install lock', () => {
    const signal = fakeSignal(written);
    syncActivity([fakeAgent('fake', signal)], 'install', home);
    writeFileSync(installLockPathOf(home), 'another-process');

    const state = uninstallActivity([fakeAgent('fake', signal)], home);

    expect(state).toMatchObject({ wanted: 'remove', plan: 'write' });
    expect(readdirSync(signal.watchDir(home))).toEqual([]);
  });

  it('names the failure when the file system refuses outright', () => {
    const signal = fakeSignal(written);
    // A file where the settings directory has to be, so every write under it fails on both platforms.
    const state = syncActivity([fakeAgent('fake', { ...signal, settingsPath: () => `${home}/.fake` })], 'install', home);

    expect(state.plan).toBe('refuse');
    expect(state.failure?.kind).toBe('activity-failed');
    expect(state.failure?.remedy).toContain(groundControlDirOf(home));
  });
});

describe('pruneMarkers', () => {
  const now = 1_788_000_000_000;

  function marker(dir: string, name: string, ageMs: number): string {
    mkdirSync(dir, { recursive: true });
    const path = `${dir}/${name}`;
    writeFileSync(path, '{}');
    const at = new Date(now - ageMs);
    utimesSync(path, at, at);

    return path;
  }

  it('sweeps a marker no session will ever end, and keeps a live one', () => {
    const signal = fakeSignal(written);
    const dir = signal.watchDir(home);
    const orphan = marker(dir, 'orphan.json', MARKER_MAX_AGE_MS + 1000);
    const live = marker(dir, 'live.json', 1000);

    pruneMarkers([fakeAgent('fake', signal)], home, now);

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  /** Nothing else on the machine sweeps a `.tmp` a failed rename left where a reader polls. */
  it('sweeps a temporary file a failed rename left behind, and leaves one a writer may still be renaming', () => {
    const stale = marker(groundControlDirOf(home), 'lanes.json.4242.tmp', TEMP_MAX_AGE_MS * 2);
    const inFlight = marker(groundControlDirOf(home), 'lanes.json.4243.tmp', 0);

    pruneMarkers([fakeAgent('fake', fakeSignal(written))], home, now);

    expect(existsSync(stale)).toBe(false);
    // The writer retries its rename for about 200 ms; a sweep inside that window loses the event it was writing.
    expect(existsSync(inFlight)).toBe(true);
  });

  /** The board's own directory holds the lane placements and the marks, which are not markers to age out. */
  it('never ages a file out of the board own directory', () => {
    const lanes = marker(groundControlDirOf(home), 'lanes.json', MARKER_MAX_AGE_MS * 2);

    pruneMarkers([fakeAgent('fake', fakeSignal(written))], home, now);

    expect(existsSync(lanes)).toBe(true);
  });

  it('tolerates a machine where nothing has ever been installed', () => {
    expect(() => pruneMarkers([fakeAgent('fake', fakeSignal(written))], home, now)).not.toThrow();
  });
});

describe('the decisions that delete files', () => {
  const now = 1_788_000_000_000;

  it('keeps the newest backups and deletes the rest, oldest first', () => {
    const names = Array.from({ length: BACKUPS_KEPT + 3 }, (_, i) => `settings-backup-claude-2026-09-0${i}.json`);

    expect(backupsToDelete(names, 'claude')).toEqual(names.slice(0, 3));
  });

  it('deletes nothing while there are fewer than it keeps', () => {
    expect(backupsToDelete(['settings-backup-claude-a.json'], 'claude')).toEqual([]);
    expect(backupsToDelete([], 'claude')).toEqual([]);
  });

  /** Two agents write different files, so one agent's backups must not push another's out of the window. */
  it('never names another agent backups', () => {
    const mine = Array.from({ length: BACKUPS_KEPT + 1 }, (_, i) => `settings-backup-claude-2026-09-0${i}.json`);
    const theirs = Array.from({ length: BACKUPS_KEPT + 1 }, (_, i) => `settings-backup-codex-2026-09-0${i}.json`);

    expect(backupsToDelete([...mine, ...theirs], 'claude')).toEqual(['settings-backup-claude-2026-09-00.json']);
    expect(backupsToDelete([...mine, ...theirs], 'codex')).toEqual(['settings-backup-codex-2026-09-00.json']);
  });

  // The refusal that matters: this list is handed to rmSync in the developer's home.
  it('never names a file that is not one of its own backups', () => {
    const names = [
      'lanes.json',
      'hub-marks.json',
      'hook.mjs',
      'install.lock',
      'activity',
      ...Array.from({ length: BACKUPS_KEPT + 1 }, (_, i) => `settings-backup-claude-2026-09-0${i}.json`),
    ];

    expect(backupsToDelete(names, 'claude')).toEqual(['settings-backup-claude-2026-09-00.json']);
  });

  it('reads a temporary file older than its window as a failed rename, and a newer one as a write in flight', () => {
    expect(tempIsOrphaned(now - TEMP_MAX_AGE_MS - 1, now)).toBe(true);
    expect(tempIsOrphaned(now - TEMP_MAX_AGE_MS + 1, now)).toBe(false);
  });

  it('reads a marker older than the window as an orphan, and a newer one as a live session own', () => {
    expect(markerIsOrphaned(now - MARKER_MAX_AGE_MS - 1, now)).toBe(true);
    expect(markerIsOrphaned(now - MARKER_MAX_AGE_MS + 1, now)).toBe(false);
    expect(markerIsOrphaned(now, now)).toBe(false);
  });
});

describe('the notice', () => {
  it('says how many sessions cannot report yet, because a silent board looks like an idle one', () => {
    expect(activityNotice({ plan: 'write', wanted: 'install', unreported: 3 })).toContain('3 sessions started before');
    expect(activityNotice({ plan: 'write', wanted: 'install', unreported: 1 })).toContain('1 session started before');
  });

  it('says only that they are installed when every session already reports', () => {
    expect(activityNotice({ plan: 'write', wanted: 'install', unreported: 0 })).toBe('Session activity hooks installed.');
  });

  // It is an announcement, not a status: a run that changed nothing has nothing to announce, however many sessions
  // cannot report. The failure of a refused run is reported as a failure, not as a state.
  it.each(['up-to-date', 'refuse', 'busy'] as const)('says nothing when the plan was %s', (plan) => {
    expect(activityNotice({ plan, wanted: 'install', unreported: 4 })).toBeNull();
    expect(activityNotice({ plan, wanted: 'remove', unreported: 4 })).toBeNull();
  });

  it('says they were removed', () => {
    expect(activityNotice({ plan: 'write', wanted: 'remove', unreported: 0 })).toContain('were removed');
  });
});
