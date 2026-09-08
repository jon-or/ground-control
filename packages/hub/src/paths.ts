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

/**
 * Where a backup of an agent's settings is taken before the hub writes to it. Named for the agent, because two of
 * them write different files and a developer restoring one has to know which is which.
 */
export function backupPathOf(home: string, at: Date, agent: string): string {
  return `${groundControlDirOf(home)}/settings-backup-${agent}-${at.toISOString().replace(/[:.]/g, '-')}.json`;
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

/** The last phase the board saw each session in, kept past its process so a card holds its mark (R6). */
export function statusPathOf(home: string): string {
  return `${groundControlDirOf(home)}/status.json`;
}

/** What the board has read about each card. One record per machine, the way lane placement is (R38). */
export function triagePathOf(home: string): string {
  return `${groundControlDirOf(home)}/triage.json`;
}

/** What the board has run on each card, and when. One record per machine, so two boards cannot both dispatch (R39). */
export function actionsPathOf(home: string): string {
  return `${groundControlDirOf(home)}/actions.json`;
}

/** Where one run may report on itself. Named per card key so two runs never overwrite each other's account. */
export function actionReportPathOf(home: string, key: string): string {
  return `${groundControlDirOf(home)}/runs/${key.replace(/[^A-Za-z0-9._-]/g, '-')}.json`;
}

/** Issues the board looked up by number for a session naming work nobody assigned the developer (R4, R9). */
export function issuesPathOf(home: string): string {
  return `${groundControlDirOf(home)}/issues.json`;
}
