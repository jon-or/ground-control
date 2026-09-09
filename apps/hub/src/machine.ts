import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { resolveStateDir } from '@ground-control/core';
import { bundlePathOf, logPathOf, spawnEnvironment } from '@ground-control/hub';

/**
 * The one part of the bridge mode that touches the machine: starting a hub for a home that has none. Detached and
 * unreferenced, so the hub outlives the browser that asked for it and ends on its own idle rule (R35).
 */
export function startHub(home: string, inheritAgentEnv = false): void {
  const stateDir = resolveStateDir(home).stateDir;

  mkdirSync(stateDir, { recursive: true });

  const log = openSync(logPathOf(stateDir), 'a');
  const env = spawnEnvironment();

  try {
    const child = spawn(process.execPath, [bundlePathOf(home), `--home=${home}`, ...(inheritAgentEnv ? ['--inherit-agent-env'] : [])], {
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
