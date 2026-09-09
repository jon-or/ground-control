import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import type { ActivityPlan, AgentAdapter, ReadFailure } from '@ground-control/core';
import { attempt, read, releaseLock, takeLock, writeAtomic, writeInPlace } from './fs.js';
import { backupPathOf, installLockPathOf } from './paths.js';

export type Wanted = 'install' | 'remove';

export interface ActivityState {
  wanted: Wanted;
  /** busy means another process holds the install lock; no settings result is known. */
  plan: ActivityPlan['kind'] | 'busy';
  /** Number of settings entries added by this run. */
  added: number;
  /** Number of owned settings entries removed by this run. */
  removed?: number;
  failure: ReadFailure | null;
}

/** Maximum retained settings backups per agent. */
export const BACKUPS_KEPT = 5;

/** Select excess backups for one agent, oldest first. Agent-prefixed timestamps keep ordering and retention independent. */
export function backupsToDelete(names: readonly string[], agent: string): string[] {
  // Unprefixed legacy backups belong to Claude.
  const legacy = agent === 'claude' ? /^settings-backup-\d/ : /^$/;
  const ours = names
    .filter((name) => name.endsWith('.json') && (name.startsWith(`settings-backup-${agent}-`) || legacy.test(name)))
    .sort();

  return ours.slice(0, Math.max(0, ours.length - BACKUPS_KEPT));
}

/** Age limit for markers left without a session-end event. */
export const MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Identify markers eligible for age-based deletion. */
export function markerIsOrphaned(mtimeMs: number, now: number): boolean {
  return now - mtimeMs > MARKER_MAX_AGE_MS;
}

/** Leave temporary files beyond the approximately 200 ms rename-retry window to avoid deleting active writes. */
export const TEMP_MAX_AGE_MS = 60_000;

/** Identify temporary files old enough to remove after failed writes. */
export function tempIsOrphaned(mtimeMs: number, now: number): boolean {
  return now - mtimeMs > TEMP_MAX_AGE_MS;
}

/** Match adapter output files named <agent>-dispatch-<id>.log for hub cleanup. */
export const DISPATCH_LOG = /^[a-z][a-z0-9-]*-dispatch-.+\.log(\.err)?$/;

/** Retention period for dispatch output. */
export const DISPATCH_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Identify dispatch logs eligible for age-based deletion. */
export function dispatchLogIsStale(mtimeMs: number, now: number): boolean {
  return now - mtimeMs > DISPATCH_LOG_MAX_AGE_MS;
}

/** Retry transient settings-file access failures during backup. */
function backup(stateDir: string, settings: string, agent: string): void {
  const base = backupPathOf(stateDir, new Date(), agent).replace(/\.json$/, '');
  for (let sequence = 0; ; sequence++) {
    try {
      attempt(() => copyFileSync(settings, `${base}-${String(sequence).padStart(6, '0')}.json`, constants.COPYFILE_EXCL));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  try {
    for (const name of backupsToDelete(readdirSync(stateDir), agent)) {
      rmSync(`${stateDir}/${name}`, { force: true });
    }
  } catch {
    // Backup retention failure must not prevent installation.
  }
}

function failed(wanted: Wanted, subject: string, stateDir: string, error: unknown, added: number, removed: number, operation: Wanted): ActivityState {
  return {
    wanted,
    plan: 'refuse',
    added,
    removed,
    failure: {
      subject,
      kind: 'activity-failed',
      message: `The board could not ${operation} its session activity hooks: ${(error as Error).message}`,
      remedy:
        'Activity reporting may be unavailable. ' +
        `A copy of your settings from before this run is in ${stateDir}.`,
    },
  };
}

/** Remove marker files without deleting the directory; skip files held by writers. */
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
      // Retry locked files during the next removal or cleanup.
    }
  }
}

/**
 * Reconcile every adapter under one filesystem lock. Install selected IDs and remove other owned hooks.
 * Global removal overrides the selection. Report the first refusal with any earlier completed changes.
 */
export function syncActivity(
  agents: readonly AgentAdapter[],
  wanted: Wanted,
  home: string,
  stateDir: string,
  insist = false,
  enabled?: ReadonlySet<string>,
  options: { lockHeld?: boolean; preserveMarkers?: boolean } = {},
): ActivityState {
  const signals = agents.flatMap((agent) =>
    agent.activity ? [{ id: agent.id, activity: agent.activity }] : [],
  );
  const lockPath = installLockPathOf(stateDir);
  let held = false;
  let added = 0;
  let removed = 0;
  let operation = wanted;
  let reached = signals[0]?.id ?? '';
  let plan: ActivityState['plan'] = 'up-to-date';

  if (signals.length === 0) {
    return { wanted, plan: 'up-to-date', added: 0, failure: null };
  }

  try {
    mkdirSync(stateDir, { recursive: true });
    held = options.lockHeld ? true : takeLock(lockPath);

    // Uninstall breaks the lock because it runs once (R34). Other operations defer to the current installer.
    if (!held && insist) {
      rmSync(lockPath, { force: true });
      held = takeLock(lockPath);
    }

    if (!held) {
      return { wanted, plan: 'busy', added: 0, failure: null };
    }

    for (const { id, activity } of signals) {
      reached = id;
      operation = wanted === 'install' && (enabled?.has(id) ?? true) ? 'install' : 'remove';
      if (operation === 'install') {
        // Retry while Windows releases open handles after directory removal (M23).
        attempt(() => mkdirSync(activity.watchDir(stateDir), { recursive: true }));
      }

      // Retain the writer after removal because existing sessions may still invoke their loaded hooks, and keep a
      // retained writer current so those sessions follow the state pointer.
      if (activity.writer && (operation === 'install' || existsSync(activity.writer.path(home))) && read(activity.writer.path(home)) !== activity.writer.source) {
        writeAtomic(activity.writer.path(home), activity.writer.source);
      }

      const settings = activity.settingsPath(home);
      const settingsText = read(settings);
      if (settingsText === null && existsSync(settings)) throw new Error('The agent settings file cannot be read.');
      const decided = activity.plan({ settingsText, home, wanted: operation });

      if (decided.kind === 'refuse') {
        return {
          wanted,
          plan: 'refuse',
          added,
          removed,
          failure: { subject: id, kind: 'activity-refused', message: decided.reason, remedy: decided.remedy },
        };
      }

      if (decided.kind === 'write') {
        if (existsSync(settings)) {
          backup(stateDir, settings, id);
        }

        writeInPlace(settings, decided.text);
        added += decided.added;
        removed += decided.removed;
        plan = 'write';
      }

      // Keep the directory to preserve watchers and avoid Windows recreation failures with open handles (M23, R25).
      if (operation === 'remove' && !options.preserveMarkers) {
        clearMarkers(activity.watchDir(stateDir));
      }
    }

    return { wanted, plan, added, removed, failure: null };
  } catch (error) {
    return failed(wanted, reached, stateDir, error, added, removed, operation);
  } finally {
    if (held && !options.lockHeld) {
      releaseLock(lockPath);
    }
  }
}

/**
 * Best-effort cleanup of old activity markers and dispatched-process output files. Killed sessions may leave
 * markers without SessionEnd; live-roster PID checks remain separate from age-based pruning.
 */
export function pruneMarkers(agents: readonly AgentAdapter[], stateDir: string, now: number = Date.now()): void {
  const dirs = new Set(agents.flatMap((agent) => (agent.activity ? [agent.activity.watchDir(stateDir)] : [])));

  // Also remove stale .tmp files from the state directory; other hub state files are excluded.
  for (const dir of [...dirs, stateDir]) {
    const markers = dirs.has(dir);

    let names: string[];

    try {
      names = readdirSync(dir);
    } catch {
      // No directory exists before the first install.
      continue;
    }

    for (const name of names) {
      const path = `${dir}/${name}`;

      try {
        const mtime = statSync(path).mtimeMs;
        const orphaned = name.endsWith('.tmp')
          ? tempIsOrphaned(mtime, now)
          : (markers && markerIsOrphaned(mtime, now)) || (!markers && DISPATCH_LOG.test(name) && dispatchLogIsStale(mtime, now));

        if (orphaned) {
          rmSync(path, { force: true });
        }
      } catch {
        // Skip missing or unreadable entries and continue cleanup.
      }
    }
  }
}

/** Remove all agent hooks and markers regardless of settings. Uninstall cannot defer because vscode:uninstall runs once. */
export function uninstallActivity(agents: readonly AgentAdapter[], home: string, stateDir: string): ActivityState {
  return syncActivity(agents, 'remove', home, stateDir, true);
}

export interface ActivityNoticeInput {
  plan: ActivityState['plan'];
  wanted: Wanted;
  added?: number;
  removed?: number;
  /** Sessions started before installation cannot report phases yet. */
  unreported: number;
}

/** Return an installation notice only when entries changed. The caller displays it once (R25). */
export function activityNotice({ plan, wanted, unreported, added, removed = 0 }: ActivityNoticeInput): string | null {
  // Announce successful writes only; refusals are reported as failures (R24).
  if (plan !== 'write') {
    return null;
  }

  if (wanted === 'remove') {
    return 'Session activity hooks removed. Existing sessions may keep reporting until restarted.';
  }

  if (added === 0 && removed > 0) {
    return 'Session activity hooks removed for disabled agents.';
  }

  const changed = removed > 0 ? 'Session activity hooks updated.' : 'Session activity hooks installed.';

  if (unreported > 0) {
    const sessions = unreported === 1 ? '1 session' : `${unreported} sessions`;

    return `${changed} Restart ${sessions} to enable activity reporting.`;
  }

  return changed;
}

/** Acknowledge explicit activity setting changes, including those requiring no writes. */
export function activityAcknowledgement(state: ActivityState): { level: 'info' | 'error'; message: string } {
  if (state.failure) {
    return { level: 'error', message: state.failure.message };
  }

  const said = activityNotice({ ...state, unreported: 0 });

  return {
    level: 'info',
    message: said ?? (state.wanted === 'install' ? 'Session activity hooks already match your settings.' : 'Session activity hooks are already absent.'),
  };
}
