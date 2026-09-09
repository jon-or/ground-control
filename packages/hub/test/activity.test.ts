import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { bootstrapDirOf } from '@ground-control/core';
import { claudeActivity } from '@ground-control/agent-claude';
import { makeCodexActivity } from '@ground-control/agent-codex';
import {
  BACKUPS_KEPT,
  MARKER_MAX_AGE_MS,
  TEMP_MAX_AGE_MS,
  activityNotice,
  activityAcknowledgement,
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
let stateDir: string;
let dispose: () => void;

beforeEach(() => {
  ({ home, dispose } = tempHome());
  stateDir = bootstrapDirOf(home);
  mkdirSync(`${home}/.fake`, { recursive: true });
});

afterEach(() => dispose());

const written = { kind: 'write', text: '{"hooks":"installed"}', added: 3, removed: 0 } as const;

describe('syncActivity', () => {
  it('writes what the adapter planned, and creates the directory the watcher reads', () => {
    const signal = fakeSignal(written);
    const state = syncActivity([fakeAgent('fake', signal)], 'install', home, stateDir);

    expect(state).toMatchObject({ wanted: 'install', plan: 'write', added: 3, failure: null });
    expect(readFileSync(signal.settingsPath(home), 'utf8')).toBe(written.text);
    expect(existsSync(signal.watchDir(stateDir))).toBe(true);
  });

  it('plans removal for an agent outside the selected set without creating its writer', () => {
    const configured = fakeSignal(written, 'fake');
    const other = fakeSignal({ kind: 'up-to-date' }, 'other');
    mkdirSync(`${home}/.other`, { recursive: true });

    const state = syncActivity(
      [fakeAgent('fake', configured), fakeAgent('other', other)],
      'install',
      home,
      stateDir,
      false,
      new Set(['fake']),
    );

    expect(configured.planned).toEqual([{ settingsText: null, wanted: 'install' }]);
    expect(other.planned).toEqual([{ settingsText: null, wanted: 'remove' }]);
    expect(existsSync(other.settingsPath(home))).toBe(false);
    expect(existsSync(other.watchDir(stateDir))).toBe(false);
    expect(existsSync(other.writer!.path(home))).toBe(false);
    expect(state).toMatchObject({ wanted: 'install', plan: 'write', added: written.added });
  });

  it('applies global removal even when an enabled set is supplied', () => {
    const signal = fakeSignal({ kind: 'up-to-date' });

    syncActivity([fakeAgent('fake', signal)], 'remove', home, stateDir, false, new Set(['fake']));

    expect(signal.planned).toEqual([{ settingsText: null, wanted: 'remove' }]);
    expect(existsSync(signal.writer!.path(home))).toBe(false);
  });

  it('reaches every agent when no ids are given, which is what a removal and an uninstall rely on', () => {
    const configured = fakeSignal(written, 'fake');
    const other = fakeSignal(written, 'other');
    mkdirSync(`${home}/.other`, { recursive: true });

    syncActivity([fakeAgent('fake', configured), fakeAgent('other', other)], 'remove', home, stateDir);

    expect(configured.planned).toEqual([{ settingsText: null, wanted: 'remove' }]);
    expect(other.planned).toEqual([{ settingsText: null, wanted: 'remove' }]);
  });

  it('names backups by agent', () => {
    const signal = fakeSignal(written, 'fake');
    writeFileSync(signal.settingsPath(home), '{"theme":"dark"}');

    syncActivity([fakeAgent('fake', signal)], 'install', home, stateDir);

    expect(readdirSync(stateDir).filter((n) => n.startsWith('settings-backup-fake-'))).toHaveLength(1);
  });

  it('passes raw settings to the adapter plan', () => {
    const signal = fakeSignal(written);
    writeFileSync(signal.settingsPath(home), '{"theme":"dark"}');

    syncActivity([fakeAgent('fake', signal)], 'install', home, stateDir);

    expect(signal.planned).toEqual([{ settingsText: '{"theme":"dark"}', wanted: 'install' }]);
  });

  it('refreshes a retained writer on removal so sessions holding it follow current behavior, but creates none', () => {
    const signal = fakeSignal(written);
    const path = signal.writer!.path(home);

    syncActivity([fakeAgent('fake', signal)], 'remove', home, stateDir);
    expect(existsSync(path)).toBe(false);

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path, 'an older writer\n');
    syncActivity([fakeAgent('fake', signal)], 'remove', home, stateDir);

    expect(readFileSync(path, 'utf8')).toBe(signal.writer!.source);
  });

  it('writes the adapter script only when its content changes', () => {
    const signal = fakeSignal(written);
    syncActivity([fakeAgent('fake', signal)], 'install', home, stateDir);

    const path = signal.writer!.path(home);
    expect(readFileSync(path, 'utf8')).toBe(signal.writer!.source);

    writeFileSync(path, signal.writer!.source);
    const before = readFileSync(path, 'utf8');
    syncActivity([fakeAgent('fake', signal)], 'install', home, stateDir);

    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('backs the settings file up before it writes over one that was already there', () => {
    const signal = fakeSignal(written);
    writeFileSync(signal.settingsPath(home), '{"theme":"dark"}');

    syncActivity([fakeAgent('fake', signal)], 'install', home, stateDir);

    const backups = readdirSync(stateDir).filter((n) => n.startsWith('settings-backup-'));

    expect(backups).toHaveLength(1);
    expect(readFileSync(`${stateDir}/${backups[0]}`, 'utf8')).toBe('{"theme":"dark"}');
  });

  it('skips backup when the settings file is absent', () => {
    syncActivity([fakeAgent('fake', fakeSignal(written))], 'install', home, stateDir);

    expect(readdirSync(stateDir).filter((n) => n.startsWith('settings-backup-'))).toEqual([]);
  });

  it('does not report installation when no entries changed', () => {
    const signal = fakeSignal({ kind: 'up-to-date' });
    const state = syncActivity([fakeAgent('fake', signal)], 'install', home, stateDir);

    expect(state).toMatchObject({ plan: 'up-to-date', added: 0, failure: null });
    expect(existsSync(signal.settingsPath(home))).toBe(false);
  });

  it('reports the refusing agent and its message', () => {
    const signal = fakeSignal({ kind: 'refuse', reason: 'the file is not JSON', remedy: 'fix it, then reopen' });
    const state = syncActivity([fakeAgent('fake', signal)], 'install', home, stateDir);

    expect(state.plan).toBe('refuse');
    expect(state.failure).toMatchObject({
      subject: 'fake',
      kind: 'activity-refused',
      message: 'the file is not JSON',
      remedy: 'fix it, then reopen',
    });
    expect(existsSync(signal.settingsPath(home))).toBe(false);
  });

  /** A second agent's refusal must preserve the first installation and identify the failing agent. */
  it('keeps what the first agent wrote when a later one refuses', () => {
    const first = fakeSignal(written, 'fake');
    const second = fakeSignal({ kind: 'refuse', reason: 'the file is not JSON', remedy: 'fix it, then reopen' }, 'other');
    mkdirSync(`${home}/.other`, { recursive: true });

    const state = syncActivity([fakeAgent('fake', first), fakeAgent('other', second)], 'install', home, stateDir);

    expect(state).toMatchObject({ plan: 'refuse', added: 3, failure: { subject: 'other' } });
    expect(readFileSync(first.settingsPath(home), 'utf8')).toBe(written.text);
    expect(existsSync(second.settingsPath(home))).toBe(false);
  });

  it('returns busy while another process holds the lock', () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(installLockPathOf(stateDir), 'another-process');

    const signal = fakeSignal(written);
    const state = syncActivity([fakeAgent('fake', signal)], 'install', home, stateDir);

    expect(state).toMatchObject({ plan: 'busy', added: 0, failure: null });
    expect(signal.planned).toEqual([]);
  });

  it('releases the lock after installation', () => {
    syncActivity([fakeAgent('fake', fakeSignal(written))], 'install', home, stateDir);

    expect(existsSync(installLockPathOf(stateDir))).toBe(false);
  });

  it('skips agents without activity signals', () => {
    const state = syncActivity([fakeAgent('quiet')], 'install', home, stateDir);

    expect(state).toMatchObject({ plan: 'up-to-date', added: 0, failure: null });
    expect(readdirSync(home)).toEqual(['.fake']);
  });

  /** Retain the writer for sessions using cached settings (R34). Keep the directory to avoid Windows recreation failures while handles remain open (M23). */
  it('empties the markers and the entries, and leaves the directory and the writer behind', () => {
    const signal = fakeSignal(written);
    syncActivity([fakeAgent('fake', signal)], 'install', home, stateDir);
    writeFileSync(`${signal.watchDir(stateDir)}/a1b2c3d4.json`, '{"phase":"working"}');

    const state = uninstallActivity([fakeAgent('fake', signal)], home, stateDir);

    expect(state).toMatchObject({ wanted: 'remove', plan: 'write' });
    expect(existsSync(signal.watchDir(stateDir))).toBe(true);
    expect(readdirSync(signal.watchDir(stateDir))).toEqual([]);
    expect(existsSync(signal.writer!.path(home))).toBe(true);
  });

  /** Turning the signal back on writes into the directory that is already there, rather than creating it again. */
  it('installs again over a directory a removal left in place', () => {
    const signal = fakeSignal(written);
    syncActivity([fakeAgent('fake', signal)], 'install', home, stateDir);
    uninstallActivity([fakeAgent('fake', signal)], home, stateDir);

    const state = syncActivity([fakeAgent('fake', signal)], 'install', home, stateDir);

    expect(state.failure).toBeNull();
    expect(existsSync(signal.watchDir(stateDir))).toBe(true);
  });

  /** Uninstall runs once, so it must remove hooks despite an existing lock (R34). */
  it('takes the signal away even while something else holds the install lock', () => {
    const signal = fakeSignal(written);
    syncActivity([fakeAgent('fake', signal)], 'install', home, stateDir);
    writeFileSync(installLockPathOf(stateDir), 'another-process');

    const state = uninstallActivity([fakeAgent('fake', signal)], home, stateDir);

    expect(state).toMatchObject({ wanted: 'remove', plan: 'write' });
    expect(readdirSync(signal.watchDir(stateDir))).toEqual([]);
  });

  it('names the failure when the file system refuses outright', () => {
    const signal = fakeSignal(written);
    // A file where the settings directory has to be, so every write under it fails on both platforms.
    const state = syncActivity([fakeAgent('fake', { ...signal, settingsPath: () => `${home}/.fake` })], 'install', home, stateDir);

    expect(state.plan).toBe('refuse');
    expect(state.failure?.kind).toBe('activity-failed');
    expect(state.failure?.remedy).toContain(stateDir);
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
    const dir = signal.watchDir(stateDir);
    const orphan = marker(dir, 'orphan.json', MARKER_MAX_AGE_MS + 1000);
    const live = marker(dir, 'live.json', 1000);

    pruneMarkers([fakeAgent('fake', signal)], stateDir, now);

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  /** Nothing else on the machine sweeps a `.tmp` a failed rename left where a reader polls. */
  it('removes stale temporary files and preserves recent writes', () => {
    const stale = marker(stateDir, 'lanes.json.4242.tmp', TEMP_MAX_AGE_MS * 2);
    const inFlight = marker(stateDir, 'lanes.json.4243.tmp', 0);

    pruneMarkers([fakeAgent('fake', fakeSignal(written))], stateDir, now);

    expect(existsSync(stale)).toBe(false);
    // The writer retries its rename for about 200 ms; a sweep inside that window loses the event it was writing.
    expect(existsSync(inFlight)).toBe(true);
  });

  /** Hub state files are excluded from marker expiry. */
  it('preserves hub state files during marker cleanup', () => {
    const lanes = marker(stateDir, 'lanes.json', MARKER_MAX_AGE_MS * 2);

    pruneMarkers([fakeAgent('fake', fakeSignal(written))], stateDir, now);

    expect(existsSync(lanes)).toBe(true);
  });

  /** Retention is the developer's to set, within bounds; only dispatch output answers to it. */
  it('deletes dispatch output older than the configured retention and nothing else', () => {
    const day = 24 * 60 * 60 * 1000;
    const old = marker(stateDir, 'claude-dispatch-abc.log', 3 * day);
    const older = marker(stateDir, 'codex-dispatch-def.log.err', 10 * day);
    const notOurs = marker(stateDir, 'notes-dispatch-abc.txt', 10 * day);

    pruneMarkers([fakeAgent('fake', fakeSignal(written))], stateDir, now, 2 * day);

    expect(existsSync(old)).toBe(false);
    expect(existsSync(older)).toBe(false);
    expect(existsSync(notOurs)).toBe(true);

    const fresh = marker(stateDir, 'claude-dispatch-ghi.log', 3 * day);

    pruneMarkers([fakeAgent('fake', fakeSignal(written))], stateDir, now, 7 * day);
    expect(existsSync(fresh)).toBe(true);
  });

  it('tolerates missing activity directories', () => {
    expect(() => pruneMarkers([fakeAgent('fake', fakeSignal(written))], stateDir, now)).not.toThrow();
  });
});

describe('the decisions that delete files', () => {
  const now = 1_788_000_000_000;

  it('keeps the newest backups and deletes the rest, oldest first', () => {
    const names = Array.from({ length: BACKUPS_KEPT + 3 }, (_, i) => `settings-backup-claude-2026-09-0${i}.json`);

    expect(backupsToDelete(names, 'claude')).toEqual(names.slice(0, 3));
  });

  it('keeps backups within the retention limit', () => {
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
  it('selects only recognized backup files', () => {
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

  it('classifies temporary files by age', () => {
    expect(tempIsOrphaned(now - TEMP_MAX_AGE_MS - 1, now)).toBe(true);
    expect(tempIsOrphaned(now - TEMP_MAX_AGE_MS + 1, now)).toBe(false);
  });

  it('classifies markers by age', () => {
    expect(markerIsOrphaned(now - MARKER_MAX_AGE_MS - 1, now)).toBe(true);
    expect(markerIsOrphaned(now - MARKER_MAX_AGE_MS + 1, now)).toBe(false);
    expect(markerIsOrphaned(now, now)).toBe(false);
  });
});

describe('selected Claude and Codex hooks', () => {
  const codex = makeCodexActivity({});
  const adapters = [fakeAgent('claude', claudeActivity), fakeAgent('codex', codex)];
  const personal = { theme: 'dark', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo personal-hook' }] }] } };
  const selected = (...ids: string[]) => syncActivity(adapters, 'install', home, stateDir, false, new Set(ids));
  const settingsOf = (signal: typeof claudeActivity) => readFileSync(signal.settingsPath(home), 'utf8');

  beforeEach(() => {
    mkdirSync(`${home}/.claude`, { recursive: true });
    mkdirSync(`${home}/.codex`, { recursive: true });
    writeFileSync(claudeActivity.settingsPath(home), JSON.stringify(personal));
    writeFileSync(codex.settingsPath(home), JSON.stringify(personal));
  });

  it.each(['claude', 'codex'])('removes only %s hooks and reinstalls them without replacing cached writers', (disabled) => {
    expect(selected('claude', 'codex')).toMatchObject({ plan: 'write', failure: null });
    const kept = disabled === 'claude' ? codex : claudeActivity;
    const removed = disabled === 'claude' ? claudeActivity : codex;
    const before = settingsOf(kept);
    const writer = readFileSync(removed.writer!.path(home), 'utf8');
    writeFileSync(`${removed.watchDir(stateDir)}/session.json`, '{}');
    writeFileSync(`${kept.watchDir(stateDir)}/session.json`, '{}');
    // Hook trust is owned by Codex; reconciliation must never rewrite its TOML state.
    writeFileSync(`${home}/.codex/config.toml`, '[hooks.state.personal]\ntrusted_hash = "keep-me"\n');

    const state = selected(disabled === 'claude' ? 'codex' : 'claude');

    expect(state).toMatchObject({ plan: 'write', added: 0, failure: null });
    expect(state.removed).toBeGreaterThan(0);
    expect(JSON.parse(settingsOf(removed))).toEqual(personal);
    expect(settingsOf(kept)).toBe(before);
    expect(readdirSync(removed.watchDir(stateDir))).toEqual([]);
    expect(readdirSync(kept.watchDir(stateDir))).toEqual(['session.json']);
    expect(readFileSync(removed.writer!.path(home), 'utf8')).toBe(writer);
    expect(readFileSync(`${home}/.codex/config.toml`, 'utf8')).toBe('[hooks.state.personal]\ntrusted_hash = "keep-me"\n');
    expect(readdirSync(stateDir).some((name) => name.startsWith(`settings-backup-${disabled}-`))).toBe(true);
    expect(selected(disabled === 'claude' ? 'codex' : 'claude')).toMatchObject({ plan: 'up-to-date', added: 0, removed: 0 });

    const restored = selected('claude', 'codex');

    expect(restored.added).toBeGreaterThan(0);
    expect(settingsOf(removed)).toContain('ground-control');
    expect(settingsOf(kept)).toBe(before);
    expect(selected('claude', 'codex')).toMatchObject({ plan: 'up-to-date', added: 0, removed: 0 });
  });

  it('reports additions and removals in one reconciliation', () => {
    selected('claude');
    const state = selected('codex');

    expect(state.added).toBeGreaterThan(0);
    expect(state.removed).toBeGreaterThan(0);
    expect(JSON.parse(settingsOf(claudeActivity))).toEqual(personal);
    expect(settingsOf(codex)).toContain('ground-control');
  });

  it('removes both agents globally despite their per-agent selections', () => {
    selected('claude', 'codex');

    const state = syncActivity(adapters, 'remove', home, stateDir, false, new Set(['claude', 'codex']));

    expect(state).toMatchObject({ wanted: 'remove', added: 0, failure: null });
    expect(state.removed).toBeGreaterThan(0);
    expect(JSON.parse(settingsOf(claudeActivity))).toEqual(personal);
    expect(JSON.parse(settingsOf(codex))).toEqual(personal);
  });

  it.each(['claude', 'codex'])('refuses malformed %s settings even when removing unselected hooks', (disabled) => {
    selected('claude', 'codex');
    const signal = disabled === 'claude' ? claudeActivity : codex;
    writeFileSync(signal.settingsPath(home), '{broken');

    const state = selected(disabled === 'claude' ? 'codex' : 'claude');

    expect(state).toMatchObject({ plan: 'refuse', failure: { subject: disabled, kind: 'activity-refused' } });
    expect(settingsOf(signal)).toBe('{broken');
    expect(existsSync(signal.writer!.path(home))).toBe(true);
    expect(existsSync(installLockPathOf(stateDir))).toBe(false);
  });
});

describe('the notice', () => {
  it('reports sessions predating activity installation', () => {
    expect(activityNotice({ plan: 'write', wanted: 'install', unreported: 3 })).toContain('Restart 3 sessions');
    expect(activityNotice({ plan: 'write', wanted: 'install', unreported: 1 })).toContain('Restart 1 session');
  });

  it('omits the pre-install count when all sessions report', () => {
    expect(activityNotice({ plan: 'write', wanted: 'install', unreported: 0 })).toBe('Session activity hooks installed.');
  });

  // Announce only successful changes; refusals are reported separately as failures.
  it.each(['up-to-date', 'refuse', 'busy'] as const)('says nothing when the plan was %s', (plan) => {
    expect(activityNotice({ plan, wanted: 'install', unreported: 4 })).toBeNull();
    expect(activityNotice({ plan, wanted: 'remove', unreported: 4 })).toBeNull();
  });

  it('reports hook removal', () => {
    expect(activityNotice({ plan: 'write', wanted: 'remove', unreported: 0 })).toContain('hooks removed');
  });

  it('does not claim installation or request restarts after removal-only reconciliation', () => {
    expect(activityNotice({ plan: 'write', wanted: 'install', added: 0, removed: 12, unreported: 3 }))
      .toBe('Session activity hooks removed for disabled agents.');
  });

  it('describes mixed changes as an update and retains the selected session restart count', () => {
    expect(activityNotice({ plan: 'write', wanted: 'install', added: 12, removed: 9, unreported: 1 }))
      .toBe('Session activity hooks updated. Restart 1 session to enable activity reporting.');
  });

  it('acknowledges a removal-only reconciliation accurately', () => {
    expect(activityAcknowledgement({ plan: 'write', wanted: 'install', added: 0, removed: 12, failure: null }))
      .toEqual({ level: 'info', message: 'Session activity hooks removed for disabled agents.' });
    expect(activityAcknowledgement({ plan: 'up-to-date', wanted: 'install', added: 0, removed: 0, failure: null }))
      .toEqual({ level: 'info', message: 'Session activity hooks already match your settings.' });
  });
});
