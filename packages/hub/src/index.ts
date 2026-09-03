export { configureHosts, defaultConfig, makeRegistries } from './registry.js';
export type { HubConfig, Registries } from './registry.js';
export {
  BACKUPS_KEPT,
  MARKER_MAX_AGE_MS,
  activityNotice,
  backupsToDelete,
  markerIsOrphaned,
  pruneMarkers,
  syncActivity,
  uninstallActivity,
} from './activityInstall.js';
export type { ActivityNoticeInput, ActivityState, Wanted } from './activityInstall.js';
export { makeLaneStore } from './lanes.js';
export type { LaneStore } from './lanes.js';
export { afterInstall, announce, makeMarkStore } from './marks.js';
export type { MarkStore, Marks } from './marks.js';
export { BATCH_MS, watchDir } from './watch.js';
export { LOCK_STALE_MS, lockIsStale, read, releaseLock, takeLock, writeAtomic, writeInPlace } from './fs.js';
export { backupPathOf, installLockPathOf, lanesPathOf, marksPathOf } from './paths.js';
