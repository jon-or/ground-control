import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('the package public surface', () => {
  it('exposes what the extension and the hub consume, and nothing test-only', () => {
    expect(Object.keys(api).sort()).toEqual([
      'PLACEMENTS',
      'SETTLING_MS',
      'VSCODE_HOST_ID',
      'VSCODE_ROUTES',
      'claudeDirOf',
      'defaultUserDir',
      'ideWindowsFrom',
      'listeningFrom',
      'liveRootsOf',
      'liveWindows',
      'makeVscodeHost',
      'openableSessions',
      'planOpen',
      'primeWindows',
      'processesFrom',
      'readWindowStores',
      'readWindows',
      'rootFrom',
      'sessionFromUri',
      'sidebarSession',
      'strayFrom',
      'surfacesFrom',
      'tabSessions',
      'verifyOpen',
      'windowForProcess',
    ]);
  });
});
