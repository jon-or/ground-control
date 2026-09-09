import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { logPathOf, makeEnsure, realEnsureDeps, spawnEnvironment } from '@ground-control/hub';
import type { Ensured } from '@ground-control/hub';

/**
 * Start a detached hub using VS Code's executable in Node mode, without requiring Node on PATH. It survives
 * the editor for browser clients and exits under the hub's idle rule (mechanics M26). Sanitize the environment
 * before spawning, including failures before hub startup.
 */
function startHub(bundle: string, home: string): void {
  const log = openSync(logPathOf(home), 'a');
  const env = spawnEnvironment();

  try {
    const child = spawn(process.execPath, [bundle, `--home=${home}`, '--inherit-agent-env'], {
      env,
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });

    child.unref();
  } finally {
    // Close the parent descriptor after spawn; repeated startup failures would otherwise leak descriptors.
    closeSync(log);
  }
}

/** One per extension host, holding the restart budget: every board in this window asks the same one. */
export function makeHubProcess(home: string, bundle: string): () => Promise<Ensured> {
  return makeEnsure(realEnsureDeps(home, () => startHub(bundle, home)));
}
