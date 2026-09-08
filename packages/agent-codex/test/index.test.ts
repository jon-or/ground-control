import { describe, expect, it } from 'vitest';
import * as codex from '../src/index.js';

describe('what the package exports', () => {
  it('offers the adapter, the signal, and the pure readers a caller needs', () => {
    expect(Object.keys(codex).sort()).toEqual([
      'CODEX_AGENT_ID',
      'CODEX_DISPLAY_NAME',
      'HOOK_SOURCE',
      'activityDirOf',
      'activityOf',
      'codexHomeOf',
      'codexHooksPathOf',
      'dispatchArgs',
      'dispatchLogPathOf',
      'hookPathOf',
      'killOnMachine',
      'makeCodexActivity',
      'makeCodexAdapter',
      'makeCodexDispatcher',
      'makeHistoryReader',
      'makeMachineStarter',
      'phaseOf',
      'pidAliveOnMachine',
      'planHookInstall',
      'readActivity',
      'readMarker',
      'readRoster',
      'rolloutExists',
      'rolloutMetadata',
      'sandboxArgs',
      'sessionIndexPathOf',
      'sessionsRootOf',
      'threadIdFrom',
      'threadNamesFrom',
    ]);
  });
});
