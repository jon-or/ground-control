import { groundControlDirOf } from '@ground-control/core';

/** Where the developer's lane placements live. One record per machine, shared by every board (R8, R9). */
export function lanesPathOf(home: string): string {
  return `${groundControlDirOf(home)}/lanes.json`;
}

/** What the hub has already done and already said, so an announcement is made once (R25). */
export function marksPathOf(home: string): string {
  return `${groundControlDirOf(home)}/hub-marks.json`;
}

/** The lock the activity install is taken under, so two processes never rewrite the agent's settings at once. */
export function installLockPathOf(home: string): string {
  return `${groundControlDirOf(home)}/install.lock`;
}

/** Where a backup of an agent's settings is taken before the hub writes to it. */
export function backupPathOf(home: string, at: Date): string {
  return `${groundControlDirOf(home)}/settings-backup-${at.toISOString().replace(/[:.]/g, '-')}.json`;
}
