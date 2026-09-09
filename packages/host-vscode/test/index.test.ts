import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('the package public surface', () => {
  it('exposes what the extension and the hub consume, and nothing test-only', () => {
    expect(Object.keys(api).sort()).toEqual([
      'DEFAULT_URI_SCHEME',
      'PLACEMENTS',
      'SETTLING_MS',
      'VSCODE_HOST_ID',
      'VSCODE_ROUTES',
      'attachFromUri',
      'changesPlan',
      'claudeDirOf',
      'defaultUserDir',
      'handOverUri',
      'handedOver',
      'handoverToken',
      'ideWindowsFrom',
      'listeningFrom',
      'liveRootsOf',
      'liveWindows',
      'makeVscodeHost',
      'noRepository',
      'openableSessions',
      'planCheckout',
      'planOpen',
      'planStart',
      'primeWindows',
      'processesFrom',
      'readWindowStores',
      'readWindows',
      'repositoryRefusal',
      'resumeRefusal',
      'rootFrom',
      'sessionFromUri',
      'sidebarSession',
      'stagedUpdate',
      'stagedUpdateRefusal',
      'startableAgents',
      'strayFrom',
      'surfacesFrom',
      'tabSessions',
      'uriSchemeOf',
      'verifyOpen',
      'windowForProcess',
    ]);
  });
});
