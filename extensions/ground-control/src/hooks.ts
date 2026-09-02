import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import * as vscode from 'vscode';
import {
  HOOK_SOURCE,
  activityDirOf,
  backupsToDelete,
  claudeSettingsPathOf,
  groundControlDirOf,
  hookPathOf,
  lockIsStale,
  markerIsOrphaned,
  planHookInstall,
} from '@ground-control/sessions';
import type { ActivityChange, HookPlan } from '@ground-control/sessions';
import { installSessionHooks } from './config.js';

export interface HookState {
  wanted: 'install' | 'remove';
  /** `busy` is another window holding the lock — not a state of the settings file, so nothing is claimed about it. */
  plan: HookPlan['kind'] | 'busy';
  /** How many entries this run actually added. Zero means nothing was installed, whatever else it did. */
  added: number;
  failure: { message: string; remedy: string } | null;
}

/** Written once per extension host, on activation. The board reads it; it does not do the writing itself. */
let current: HookState | undefined;

/**
 * The state the board reports. A `busy` run observed another window's lock and settled nothing, so it is retried rather than cached: a lock left
 * by a window that crashed leaves this one showing no phase for anything, with nothing on screen saying why (R25).
 */
export function hookState(): HookState {
  return current === undefined || current.plan === 'busy' ? syncHooks() : current;
}

/** Never throws: a file that cannot be read is one the caller has to cope with, not an error to propagate. */
export function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The lock's own identity. The `finally` must not unlink a lock that is no longer the one it took: another window
 * whose turn came while this one was stalled would then be writing settings.json with nothing holding the door.
 */
const NONCE = `${process.pid}-${Math.random().toString(36).slice(2)}`;

function lock(path: string): boolean {
  const take = (): boolean => {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, NONCE);
      closeSync(fd);
    } catch {
      return false;
    }

    // Exclusive create is not enough on its own: breaking a stale lock is a delete and a create, and two windows
    // doing that at once both succeed. Whoever's nonce is in the file at the end is the one that holds it.
    return read(path) === NONCE;
  };

  if (take()) {
    return true;
  }

  try {
    if (!lockIsStale(statSync(path).mtimeMs, Date.now())) {
      return false;
    }
  } catch {
    return false;
  }

  rmSync(path, { force: true });

  return take();
}

function release(path: string): void {
  try {
    if (read(path) === NONCE) {
      rmSync(path, { force: true });
    }
  } catch {
    // A lock that has already gone, or one another window now owns.
  }
}

/** A real sleep, not a spin: the lock being waited out is another process's, so this thread has nothing to do. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Retried: on Windows a write to a path another process has momentarily open fails outright and succeeds a moment later — measured on
 * `~/.claude/settings.json`, which every live session reads. Synchronous, because 90 ms is the whole budget and a torn settings file is not.
 */
function attempt(action: () => void): void {
  for (let left = 3; ; left--) {
    try {
      action();

      return;
    } catch (error) {
      if (left === 0) {
        throw error;
      }

      pause(30);
    }
  }
}

/**
 * In place for `settings.json`: a rename over a path something else holds open fails where a write does not, and the backup taken beforehand is
 * what makes truncating safe. Temp-then-rename for a file nothing else reads, so a partial one is never visible, falling back to in place.
 */
function write(path: string, text: string, viaRename: boolean): void {
  if (!viaRename) {
    attempt(() => writeFileSync(path, text));

    return;
  }

  const temp = `${path}.${process.pid}.tmp`;

  attempt(() => writeFileSync(temp, text));

  try {
    attempt(() => renameSync(temp, path));
  } catch {
    attempt(() => writeFileSync(path, text));
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Retried like every other read of `settings.json`: an install a 30 ms wait would have completed must not fail. */
function backup(dir: string, settings: string): void {
  const to = `${dir}/settings-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

  attempt(() => copyFileSync(settings, to));

  try {
    for (const name of backupsToDelete(readdirSync(dir))) {
      rmSync(`${dir}/${name}`, { force: true });
    }
  } catch {
    // Retention is housekeeping. Failing it must not fail the install the backup was taken for.
  }
}

/**
 * Writes the activity hook and points the developer's own Claude Code settings at it, or takes the entries away again. Every decision — what to
 * write, what to refuse, what to sweep — belongs to `@ground-control/sessions`; this is the file system and nothing else.
 */
export function syncHooks(home = homedir()): HookState {
  const wanted = installSessionHooks() ? 'install' : 'remove';
  const dir = groundControlDirOf(home);
  const settings = claudeSettingsPathOf(home);
  const lockPath = `${dir}/install.lock`;
  const state = (plan: HookState['plan'], added = 0, failure: HookState['failure'] = null): HookState => {
    current = { wanted, plan, added, failure };

    return current;
  };

  let held = false;

  try {
    mkdirSync(dir, { recursive: true });
    held = lock(lockPath);

    // Another window is mid-install. Its write is the one this would make, so nothing is claimed either way.
    if (!held) {
      return state('busy');
    }

    // The writer stays on disk through a removal: a session that already loaded the old settings goes on spawning
    // it, and a missing script is a hook failure the developer sees in their own terminal.
    if (wanted === 'install') {
      mkdirSync(activityDirOf(home), { recursive: true });

      const writer = hookPathOf(home);

      if (read(writer) !== HOOK_SOURCE) {
        write(writer, HOOK_SOURCE, true);
      }
    }

    const plan = planHookInstall({ settingsText: read(settings), home, wanted });

    if (plan.kind === 'refuse') {
      return state('refuse', 0, { message: plan.reason, remedy: plan.remedy });
    }

    if (plan.kind === 'write') {
      if (existsSync(settings)) {
        backup(dir, settings);
      }

      write(settings, plan.text, false);
    }

    // Best effort, and in its own catch: a live session's hook writing into this directory as it goes makes the
    // removal throw, and a removal that worked must not be reported as an install that failed.
    if (wanted === 'remove') {
      try {
        rmSync(activityDirOf(home), { recursive: true, force: true });
      } catch {
        // The markers outlive the entries. Nothing reads them, and the next install sweeps them.
      }
    }

    return state(plan.kind, plan.kind === 'write' ? plan.added : 0);
  } catch (error) {
    return state('refuse', 0, {
      message: `The board could not ${wanted === 'install' ? 'install' : 'remove'} its session activity hooks: ${(error as Error).message}`,
      remedy:
        `Sessions still appear on the board; they cannot report what they are doing. ` +
        `A copy of your settings from before this run is in ${dir}.`,
    });
  } finally {
    if (held) {
      release(lockPath);
    }
  }
}

/**
 * Markers of sessions that never fired `SessionEnd` — a pid kill and a VS Code crash both fire nothing, and Claude
 * Code will never sweep a directory of ours. Best effort: a marker that outlives its session costs nothing but disk.
 */
export function pruneMarkers(home = homedir()): void {
  // Both directories: a rename that failed leaves a `.tmp` behind, and nothing else on the machine sweeps one.
  for (const dir of [activityDirOf(home), groundControlDirOf(home)]) {
    try {
      for (const name of readdirSync(dir)) {
        const path = `${dir}/${name}`;
        const orphan = markerIsOrphaned(statSync(path).mtimeMs, Date.now());

        if (name.endsWith('.tmp') || (dir.endsWith('activity') && orphan)) {
          rmSync(path, { force: true });
        }
      }
    } catch {
      // Nothing to prune, or nothing prunable.
    }
  }
}

/**
 * Watches for hooks reporting a change. A phase change is what the developer is looking at, so it reaches the board
 * at once rather than on the next session poll — and it costs a file read, not the CLI spawn a poll costs.
 *
 * Which markers changed and how, because a marker appearing or being removed is a session the board has to read the
 * CLI to place, where a phase on a session already up is a file read (`rosterIsStale`).
 */
export function watchActivity(home: string, onChange: (changes: ActivityChange[]) => void): vscode.Disposable {
  const pattern = new vscode.RelativePattern(vscode.Uri.file(activityDirOf(home)), '*.json');
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  // A turn boundary writes several markers at once, and every one of them would otherwise re-post the whole board. The
  // window runs from the first event and is never extended: 17 live sessions can write faster than it, and a batch that
  // re-arms on every write is a session end that never reaches the board.
  let pending: NodeJS.Timeout | undefined;
  let batch: ActivityChange[] = [];

  const changed = (kind: ActivityChange['kind']) => (uri: vscode.Uri): void => {
    batch.push({ kind, sessionId: basename(uri.fsPath, '.json') });

    pending ??= setTimeout(() => {
      const changes = batch;

      batch = [];
      pending = undefined;
      onChange(changes);
    }, 150);
  };

  watcher.onDidCreate(changed('created'));
  watcher.onDidChange(changed('changed'));
  watcher.onDidDelete(changed('deleted'));

  return new vscode.Disposable(() => {
    clearTimeout(pending);
    watcher.dispose();
  });
}
