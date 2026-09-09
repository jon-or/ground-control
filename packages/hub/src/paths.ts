import { groundControlDirOf } from '@ground-control/core';

/** Shared lane placement file (R8, R9). */
export function lanesPathOf(home: string): string {
  return `${groundControlDirOf(home)}/lanes.json`;
}

/** Installation and notice acknowledgments (R25). */
export function marksPathOf(home: string): string {
  return `${groundControlDirOf(home)}/hub-marks.json`;
}

/** Shared activity-installation lock. */
export function installLockPathOf(home: string): string {
  return `${groundControlDirOf(home)}/install.lock`;
}

/** Agent-prefixed settings backup path. */
export function backupPathOf(home: string, at: Date, agent: string): string {
  return `${groundControlDirOf(home)}/settings-backup-${agent}-${at.toISOString().replace(/[:.]/g, '-')}.json`;
}

/** Saved client configuration for hub restarts. */
export function configPathOf(home: string): string {
  return `${groundControlDirOf(home)}/config.json`;
}

/** Connection record; probe for liveness because forced termination leaves it behind. */
export function hubJsonPathOf(home: string): string {
  return `${groundControlDirOf(home)}/hub.json`;
}

/** Hub stdout/stderr log, which may include checkout paths and titles. */
export function logPathOf(home: string): string {
  return `${groundControlDirOf(home)}/hub.log`;
}

/** Last hub exit reason for startup diagnostics. */
export function exitPathOf(home: string): string {
  return `${groundControlDirOf(home)}/hub-exit.json`;
}

/** Stable hub bundle path used across extension updates. */
export function bundlePathOf(home: string): string {
  return `${groundControlDirOf(home)}/hub.js`;
}

/** Persisted session phases retained after process exit (R6). */
export function statusPathOf(home: string): string {
  return `${groundControlDirOf(home)}/status.json`;
}

/** Shared persisted card triage (R38). */
export function triagePathOf(home: string): string {
  return `${groundControlDirOf(home)}/triage.json`;
}

/** Shared user-selected card checkouts. */
export function checkoutsPathOf(home: string): string {
  return `${groundControlDirOf(home)}/checkouts.json`;
}

/** Shared card action history and dispatch timestamps (R39). */
export function actionsPathOf(home: string): string {
  return `${groundControlDirOf(home)}/actions.json`;
}

/** Result path per card; concurrent cards use separate files. */
export function actionReportPathOf(home: string, key: string): string {
  return `${groundControlDirOf(home)}/runs/${key.replace(/[^A-Za-z0-9._-]/g, '-')}.json`;
}

/** Cached session-linked issue metadata (R4, R9). */
export function issuesPathOf(home: string): string {
  return `${groundControlDirOf(home)}/issues.json`;
}
