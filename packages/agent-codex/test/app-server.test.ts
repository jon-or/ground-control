import { describe, expect, it } from 'vitest';
import { makeTrustOnMachine } from '../src/appServer.js';
import { HOME } from './helpers.js';

describe('asking Codex to trust the hooks', () => {
  it('reports missing executable paths without spawning', async () => {
    const attempt = await makeTrustOnMachine({})('D:/nowhere/codex-does-not-exist.exe', HOME);

    expect(attempt).toBe('no Codex executable at "D:/nowhere/codex-does-not-exist.exe"');
  });

  /** Use Node with a nonexistent app-server script to exercise child exit before a response. */
  it('fails immediately when the server exits before replying', async () => {
    const attempt = await makeTrustOnMachine({})(process.execPath, HOME);

    expect(attempt).toBe('Codex stopped before it answered');
  });
});
