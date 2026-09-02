import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('the package public surface', () => {
  it('exposes what the extension consumes, and nothing test-only', () => {
    expect(Object.keys(api).sort()).toEqual([
      'HOOK_SOURCE',
      'activityDirOf',
      'backupsToDelete',
      'claudeSettingsPathOf',
      'fetchSessions',
      'groundControlDirOf',
      'hookNotice',
      'hookPathOf',
      'lockIsStale',
      'markerIsOrphaned',
      'planHookInstall',
      'providers',
      'readActivity',
      'rosterIsStale',
      'unreportedSessions',
    ]);
  });
});
