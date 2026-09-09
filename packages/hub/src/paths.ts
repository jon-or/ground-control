import { bootstrapDirOf } from '@ground-control/core';

/** Files below take the resolved state directory; only the bundle and relocation lock live in the fixed bootstrap directory. */

/** Shared lane placement file (R8, R9). */
export function lanesPathOf(stateDir: string): string {
  return `${stateDir}/lanes.json`;
}

/** Installation and notice acknowledgments (R25). */
export function marksPathOf(stateDir: string): string {
  return `${stateDir}/hub-marks.json`;
}

/** Shared activity-installation lock. */
export function installLockPathOf(stateDir: string): string {
  return `${stateDir}/install.lock`;
}

/** Agent-prefixed settings backup path. */
export function backupPathOf(stateDir: string, at: Date, agent: string): string {
  return `${stateDir}/settings-backup-${agent}-${at.toISOString().replace(/[:.]/g, '-')}.json`;
}

/** Saved client configuration for hub restarts. */
export function configPathOf(stateDir: string): string {
  return `${stateDir}/config.json`;
}

/** Connection record; probe for liveness because forced termination leaves it behind. */
export function hubJsonPathOf(stateDir: string): string {
  return `${stateDir}/hub.json`;
}

/** Hub stdout/stderr log, which may include checkout paths and titles. */
export function logPathOf(stateDir: string): string {
  return `${stateDir}/hub.log`;
}

/** Last hub exit reason for startup diagnostics. */
export function exitPathOf(stateDir: string): string {
  return `${stateDir}/hub-exit.json`;
}

/** Stable hub bundle path in the bootstrap directory, used across extension updates and by the native launcher. */
export function bundlePathOf(home: string): string {
  return `${bootstrapDirOf(home)}/hub.js`;
}

/** Lock held while one client moves the state directory. */
export function relocateLockPathOf(home: string): string {
  return `${bootstrapDirOf(home)}/relocate.lock`;
}

/** Persisted session phases retained after process exit (R6). */
export function statusPathOf(stateDir: string): string {
  return `${stateDir}/status.json`;
}

/** Shared persisted card triage (R38). */
export function triagePathOf(stateDir: string): string {
  return `${stateDir}/triage.json`;
}

/** Shared user-selected card checkouts. */
export function checkoutsPathOf(stateDir: string): string {
  return `${stateDir}/checkouts.json`;
}

/** Shared card action history and dispatch timestamps (R39). */
export function actionsPathOf(stateDir: string): string {
  return `${stateDir}/actions.json`;
}

/** Result path per card; concurrent cards use separate files. */
export function actionReportPathOf(stateDir: string, key: string): string {
  return `${stateDir}/runs/${key.replace(/[^A-Za-z0-9._-]/g, '-')}.json`;
}

/** Cached session-linked issue metadata (R4, R9). */
export function issuesPathOf(stateDir: string): string {
  return `${stateDir}/issues.json`;
}
