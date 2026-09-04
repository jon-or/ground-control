import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { groundControlDirOf } from '@ground-control/core';
import { read, shouldWrite, stamp, writeAtomic } from '@ground-control/hub';

/**
 * Puts the hub this extension carries at the one path every client starts it from. Written on activation, the way
 * the activity hook writer already is: an update that changed the hub is otherwise never picked up, because the
 * process on disk is what runs and nothing else replaces it.
 */
export function writeBundle(home: string, extensionPath: string, version: string, target: string): void {
  const carried = stamp(version, readFileSync(join(extensionPath, 'dist', 'hub.js'), 'utf8'));

  if (shouldWrite(carried, read(target))) {
    mkdirSync(groundControlDirOf(home), { recursive: true });
    writeAtomic(target, carried);

    // Read and run by the developer's own node, never by anyone else's: the directory is theirs, and the file is a
    // process this extension is about to start.
    chmodSync(target, 0o600);
  }
}
