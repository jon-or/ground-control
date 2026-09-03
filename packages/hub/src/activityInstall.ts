import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { groundControlDirOf } from '@ground-control/core';
import type { ActivityPlan, AgentAdapter, ReadFailure } from '@ground-control/core';
import { attempt, read, releaseLock, takeLock, writeAtomic, writeInPlace } from './fs.js';
import { backupPathOf, installLockPathOf } from './paths.js';

export type Wanted = 'install' | 'remove';

export interface ActivityState {
  wanted: Wanted;
  /** `busy` is another process holding the install lock — not a state of any settings file, so nothing is claimed. */
  plan: ActivityPlan['kind'] | 'busy';
  /** How many entries this run actually added. Zero means nothing was installed, whatever else it did. */
  added: number;
  failure: ReadFailure | null;
}

/** How many backups of an agent's settings file are kept. Enough to undo a bad run, not enough to accumulate. */
export const BACKUPS_KEPT = 5;

/**
 * The backups to delete, oldest first. Named for the time they were taken, so the names sort chronologically and the
 * newest are the tail. This list is handed to `rmSync` in the developer's home, which is why it is a tested function
 * rather than a slice expression in glue code.
 */
export function backupsToDelete(names: readonly string[]): string[] {
  const ours = names.filter((name) => /^settings-backup-.+\.json$/.test(name)).sort();

  return ours.slice(0, Math.max(0, ours.length - BACKUPS_KEPT));
}

/** How long an orphaned marker is kept. A session that never reported its end leaves one, and nothing else sweeps it. */
export const MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Whether a marker is old enough to be an orphan rather than a live session's. Deletes files, so it is tested. */
export function markerIsOrphaned(mtimeMs: number, now: number): boolean {
  return now - mtimeMs > MARKER_MAX_AGE_MS;
}

/** Retried like every other read of a settings file: an install a 30 ms wait would have completed must not fail. */
function backup(home: string, settings: string): void {
  attempt(() => copyFileSync(settings, backupPathOf(home, new Date())));

  try {
    const dir = groundControlDirOf(home);

    for (const name of backupsToDelete(readdirSync(dir))) {
      rmSync(`${dir}/${name}`, { force: true });
    }
  } catch {
    // Retention is housekeeping. Failing it must not fail the install the backup was taken for.
  }
}

function failed(wanted: Wanted, subject: string, home: string, error: unknown): ActivityState {
  return {
    wanted,
    plan: 'refuse',
    added: 0,
    failure: {
      subject,
      kind: 'activity-failed',
      message: `The board could not ${wanted === 'install' ? 'install' : 'remove'} its session activity hooks: ${(error as Error).message}`,
      remedy:
        'Sessions still appear on the board; they cannot report what they are doing. ' +
        `A copy of your settings from before this run is in ${groundControlDirOf(home)}.`,
    },
  };
}

/** Empties an activity directory without removing it. Best effort per file: a live session's writer may be in it. */
function clearMarkers(dir: string): void {
  let names: string[] = [];

  try {
    names = readdirSync(dir);
  } catch {
    return;
  }

  for (const name of names) {
    try {
      rmSync(`${dir}/${name}`, { force: true });
    } catch {
      // A writer holds it open. Nothing reads it, and the next removal or prune takes it.
    }
  }
}

/**
 * Puts each agent's activity signal in place, or takes it away. Every decision — what to write, what to refuse — is
 * the adapter's; this is the file system and the lock, and nothing else. Reports what it observed, never what it
 * intended (R25).
 *
 * One state, not one per agent: only Claude offers a signal today, and a per-agent notice would be a board saying
 * two things at once about one act. The first agent that refuses is what the board reports.
 */
export function syncActivity(agents: readonly AgentAdapter[], wanted: Wanted, home: string, insist = false): ActivityState {
  const signals = agents.flatMap((agent) => (agent.activity ? [{ id: agent.id, activity: agent.activity }] : []));
  const lockPath = installLockPathOf(home);
  let held = false;
  let added = 0;
  let plan: ActivityState['plan'] = 'up-to-date';

  if (signals.length === 0) {
    return { wanted, plan: 'up-to-date', added: 0, failure: null };
  }

  try {
    mkdirSync(groundControlDirOf(home), { recursive: true });
    held = takeLock(lockPath);

    // An uninstall runs once and is never retried, so it breaks a lock rather than leaving entries that name a
    // writer nobody maintains firing forever (R34). Everything else defers: the holder's write is the one this
    // would make, so nothing is claimed either way.
    if (!held && insist) {
      rmSync(lockPath, { force: true });
      held = takeLock(lockPath);
    }

    if (!held) {
      return { wanted, plan: 'busy', added: 0, failure: null };
    }

    for (const { id, activity } of signals) {
      // The writer stays on disk through a removal: a session that already loaded the old settings goes on spawning
      // it, and a missing script is a hook failure the developer sees in their own terminal.
      if (wanted === 'install') {
        // Retried: a directory another process is still holding open after a removal refuses this until that handle
        // goes, and the window is short (`mechanics.md` §23).
        attempt(() => mkdirSync(activity.watchDir(home), { recursive: true }));

        if (activity.writer && read(activity.writer.path(home)) !== activity.writer.source) {
          writeAtomic(activity.writer.path(home), activity.writer.source);
        }
      }

      const settings = activity.settingsPath(home);
      const decided = activity.plan({ settingsText: read(settings), home, wanted });

      if (decided.kind === 'refuse') {
        return {
          wanted,
          plan: 'refuse',
          added,
          failure: { subject: id, kind: 'activity-refused', message: decided.reason, remedy: decided.remedy },
        };
      }

      if (decided.kind === 'write') {
        if (existsSync(settings)) {
          backup(home, settings);
        }

        writeInPlace(settings, decided.text);
        added += decided.added;
        plan = 'write';
      }

      // The markers go and the directory stays. Removing the directory means recreating it on the next install,
      // and a directory something still holds open after a delete cannot be recreated (`mechanics.md` §23); it also
      // costs the watcher, which dies with the directory and takes up to a second to come back (R25).
      if (wanted === 'remove') {
        clearMarkers(activity.watchDir(home));
      }
    }

    return { wanted, plan, added, failure: null };
  } catch (error) {
    return failed(wanted, signals[0]!.id, home, error);
  } finally {
    if (held) {
      releaseLock(lockPath);
    }
  }
}

/**
 * Markers of sessions that never reported an end — a killed process and a crashed editor both report nothing, and no
 * agent will ever sweep a directory of ours. Best effort: a marker that outlives its session costs nothing but disk.
 */
export function pruneMarkers(agents: readonly AgentAdapter[], home: string, now: number = Date.now()): void {
  const dirs = new Set(agents.flatMap((agent) => (agent.activity ? [agent.activity.watchDir(home)] : [])));

  // The board's own directory too, but only for a `.tmp` a failed rename left behind: nothing else on the machine
  // sweeps one, and the files beside it are the hub's own and are not orphans to age out.
  for (const dir of [...dirs, groundControlDirOf(home)]) {
    const markers = dirs.has(dir);

    try {
      for (const name of readdirSync(dir)) {
        const path = `${dir}/${name}`;

        if (name.endsWith('.tmp') || (markers && markerIsOrphaned(statSync(path).mtimeMs, now))) {
          rmSync(path, { force: true });
        }
      }
    } catch {
      // Nothing to prune, or nothing prunable.
    }
  }
}

/**
 * Takes every agent's signal away and removes the markers, without consulting a setting. This is what an uninstall
 * runs: it insists on the lock, because `vscode:uninstall` fires once and a deferral here is entries left forever.
 */
export function uninstallActivity(agents: readonly AgentAdapter[], home: string): ActivityState {
  return syncActivity(agents, 'remove', home, true);
}

export interface ActivityNoticeInput {
  plan: ActivityState['plan'];
  wanted: Wanted;
  /** Listed sessions that started before the install and so cannot report a phase yet. */
  unreported: number;
}

/**
 * The one sentence the board puts above the lanes, and only when it has something new to say: a run that changed
 * nothing announces nothing. It is an announcement, not a status — the caller shows it once (R25).
 */
export function activityNotice({ plan, wanted, unreported }: ActivityNoticeInput): string | null {
  // Only an actual write is news. A refusal is reported as a failure instead: saying "installed" beside the reason
  // it could not be is the board contradicting itself on one screen (R24).
  if (plan !== 'write') {
    return null;
  }

  if (wanted === 'remove') {
    return 'Session activity hooks were removed. Sessions no longer report what they are doing.';
  }

  if (unreported > 0) {
    const sessions = unreported === 1 ? '1 session' : `${unreported} sessions`;

    return `Session activity hooks installed. ${sessions} started before that and will not report until restarted.`;
  }

  return 'Session activity hooks installed.';
}
