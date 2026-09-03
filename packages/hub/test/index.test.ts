import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('the package public surface', () => {
  it('exposes what a client and the daemon consume, and nothing test-only', () => {
    expect(Object.keys(api).sort()).toEqual([
      'BACKUPS_KEPT',
      'BATCH_MS',
      'LOCK_STALE_MS',
      'MARKER_MAX_AGE_MS',
      'activityNotice',
      'afterInstall',
      'announce',
      'backupPathOf',
      'backupsToDelete',
      'configureHosts',
      'defaultConfig',
      'installLockPathOf',
      'lanesPathOf',
      'lockIsStale',
      'makeLaneStore',
      'makeMarkStore',
      'makeRegistries',
      'markerIsOrphaned',
      'marksPathOf',
      'pruneMarkers',
      'read',
      'releaseLock',
      'syncActivity',
      'takeLock',
      'uninstallActivity',
      'watchDir',
      'writeAtomic',
      'writeIfChanged',
      'writeInPlace',
    ]);
  });
});
