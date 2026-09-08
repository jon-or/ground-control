import { describe, expect, it } from 'vitest';
import { makeTrustOnMachine } from '../src/appServer.js';
import { HOME } from './helpers.js';

describe('asking Codex to trust the hooks', () => {
  it('names the path rather than spawning, when nothing is there to spawn', async () => {
    const attempt = await makeTrustOnMachine({})('D:/nowhere/codex-does-not-exist.exe', HOME);

    expect(attempt).toBe('no Codex executable at "D:/nowhere/codex-does-not-exist.exe"');
  });

  /** A real child process: this layer is the spawn, so a fake here would test nothing. Node given `app-server` as
   * its script exits at once, which is the path a Codex that dies before answering takes. */
  it('reports a server that exits before answering, rather than waiting out the budget', async () => {
    const attempt = await makeTrustOnMachine({})(process.execPath, HOME);

    expect(attempt).toBe('Codex stopped before it answered');
  });
});
