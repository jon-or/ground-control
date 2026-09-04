import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { bundlePathOf, logPathOf, spawnEnvironment } from '@ground-control/hub';

/**
 * The one part of the bridge mode that touches the machine: starting a hub for a home that has none. Detached and
 * unreferenced, so the hub outlives the browser that asked for it and ends on its own idle rule (R35).
 */
export function startHub(home: string): void {
  const log = openSync(logPathOf(home), 'a');
  const env = spawnEnvironment();

  try {
    const child = spawn(process.execPath, [bundlePathOf(home), `--home=${home}`], {
      env,
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });

    child.unref();
  } finally {
    closeSync(log);
  }
}
