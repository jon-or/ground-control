import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { logPathOf, makeEnsure, realEnsureDeps, spawnEnvironment } from '@ground-control/hub';
import type { Ensured } from '@ground-control/hub';

/**
 * Starts the hub as its own process, detached, so it outlives the window that asked for it: closing the last VS Code
 * window leaves the tracking up for the browser overlay, and the idle rule is what ends it (`mechanics.md` §26).
 *
 * `process.execPath` is VS Code's own Electron running as node — the Node already measured on this machine — so
 * there is no search for an interpreter that a launcher's PATH may not have (`mechanics.md` §21). The environment is
 * cleaned here as well as in the hub, because a spawn that failed before the hub's own startup ran would inherit it.
 */
function startHub(bundle: string, home: string): void {
  const log = openSync(logPathOf(home), 'a');
  const env = spawnEnvironment();

  try {
    const child = spawn(process.execPath, [bundle, `--home=${home}`], {
      env,
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });

    child.unref();
  } finally {
    // The child has its own duplicate by now. Keeping this one costs a descriptor per start, which a hub that
    // will not stay up spends until the extension host runs out of them.
    closeSync(log);
  }
}

/** One per extension host, holding the restart budget: every board in this window asks the same one. */
export function makeHubProcess(home: string, bundle: string): () => Promise<Ensured> {
  return makeEnsure(realEnsureDeps(home, () => startHub(bundle, home)));
}
