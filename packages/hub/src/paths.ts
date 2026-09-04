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

/** The last configuration a client pushed, so the next hub starts on the developer's settings rather than defaults. */
export function configPathOf(home: string): string {
  return `${groundControlDirOf(home)}/config.json`;
}

/** Where a running hub says how to reach it. Discovery, never liveness: a killed hub leaves this behind. */
export function hubJsonPathOf(home: string): string {
  return `${groundControlDirOf(home)}/hub.json`;
}

/** Everything the hub writes to stdout and stderr, including the cwds and titles the snapshot carries. */
export function logPathOf(home: string): string {
  return `${groundControlDirOf(home)}/hub.log`;
}

/** Why the last hub stopped, so a client whose spawn never came up has something to quote. */
export function exitPathOf(home: string): string {
  return `${groundControlDirOf(home)}/hub-exit.json`;
}

/** The hub a client carries, written here so an extension update never orphans the path a manifest already names. */
export function bundlePathOf(home: string): string {
  return `${groundControlDirOf(home)}/hub.js`;
}
