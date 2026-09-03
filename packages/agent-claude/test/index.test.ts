import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('the package public surface', () => {
  it('exposes the adapter and what the hub needs to install and read its signal, and nothing test-only', () => {
    expect(Object.keys(api).sort()).toEqual([
      'CLAUDE_AGENT_ID',
      'CLAUDE_DISPLAY_NAME',
      'HOOK_SOURCE',
      'activityDirOf',
      'backupsToDelete',
      'claudeActivity',
      'claudeSettingsPathOf',
      'hookNotice',
      'hookPathOf',
      'lockIsStale',
      'makeClaudeAdapter',
      'markerIsOrphaned',
      'planHookInstall',
      'readActivity',
      'rosterIsStale',
      'unreportedSessions',
    ]);
  });
});
