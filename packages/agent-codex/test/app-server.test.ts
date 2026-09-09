import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeTrustOnMachine } from '../src/appServer.js';
import { HOME } from './helpers.js';

describe('asking Codex to trust the hooks', () => {
  it('launches the trust child with the per-request profile instead of the factory environment', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gc-trust-env-'));
    try {
      const preload = join(home, 'capture.cjs');
      const capture = join(home, 'env.json');
      writeFileSync(preload, "require('node:fs').writeFileSync(process.env.GC_CAPTURE, JSON.stringify({root:process.env.CODEX_HOME})); process.exit(0);");
      const trust = makeTrustOnMachine({ CODEX_HOME: '/old-profile' });
      const result = await trust(process.execPath, home, {
        ...process.env, CODEX_HOME: join(home, 'selected profile'), GC_CAPTURE: capture, NODE_OPTIONS: `--require "${preload.replace(/\\/g, '/')}"`,
      });
      expect(result).toBe('Codex stopped before it answered');
      expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual({ root: join(home, 'selected profile').replace(/\\/g, '/') });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
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
