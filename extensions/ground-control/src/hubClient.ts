import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { parseAuthStatusLogins } from '@ground-control/github';
import { Hub, makeLaneStore, makeMarkStore, realHubDeps, watchDir } from '@ground-control/hub';
import { registries } from './registry.js';

/** Whose issues these are, seeded from what the CLI already knows. The hub has no screen, so it only detects (R26). */
function detectLogins(ghPath: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(ghPath, ['auth', 'status'], (_error, stdout, stderr) =>
      resolve(parseAuthStatusLogins(`${stdout}${stderr}`)),
    );
  });
}

let current: Hub | undefined;

/**
 * The one hub this extension host talks to, connected to in process. Every board is a client of the same protocol,
 * so where the hub runs is a transport rather than a shape.
 */
export function hub(home: string = homedir()): Hub {
  current ??= new Hub(
    realHubDeps(registries, makeLaneStore(home), makeMarkStore(home), home, watchDir, detectLogins),
  );

  return current;
}

export function disposeHub(): void {
  current?.dispose();
  current = undefined;
}
