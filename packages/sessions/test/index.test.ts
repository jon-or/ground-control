import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('the package public surface', () => {
  it('exposes what the extension consumes, and nothing test-only', () => {
    expect(Object.keys(api).sort()).toEqual([
      'HOOK_SOURCE',
      'activityDirOf',
      'backupsToDelete',
      'claudeDirOf',
      'claudeSettingsPathOf',
      'dirKey',
      'fetchSessions',
      'groundControlDirOf',
      'hookNotice',
      'hookPathOf',
      'ideWindowsFrom',
      'listeningFrom',
      'liveRootsOf',
      'liveWindows',
      'lockIsStale',
      'markerIsOrphaned',
      'openableSessions',
      'planHookInstall',
      'planOpen',
      'processesFrom',
      'providers',
      'readActivity',
      'rosterIsStale',
      'sessionName',
      'strayFrom',
      'surfacesFrom',
      'unreportedSessions',
      'verifyOpen',
      'windowForProcess',
    ]);
  });
});
