import { homedir } from 'node:os';
import { Hub, makeHub } from '@ground-control/hub';

let current: Hub | undefined;

/**
 * The one hub this extension host talks to, connected to in process. Every board is a client of the same protocol,
 * so where the hub runs is a transport rather than a shape.
 */
export function hub(home: string = homedir()): Hub {
  current ??= makeHub(home);

  return current;
}

export function disposeHub(): void {
  current?.dispose();
  current = undefined;
}
