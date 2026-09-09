import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapDirOf } from '@ground-control/core';
import { read, shouldWrite, stamp, writeAtomic } from '@ground-control/hub';

/** Copy the bundled hub to the shared launch path on activation so extension updates replace the executable. */
export function writeBundle(home: string, extensionPath: string, version: string, target: string): void {
  const carried = stamp(version, readFileSync(join(extensionPath, 'dist', 'hub.js'), 'utf8'));

  if (shouldWrite(carried, read(target))) {
    mkdirSync(bootstrapDirOf(home), { recursive: true });
    writeAtomic(target, carried);

    // Restrict the executable to its owner.
    chmodSync(target, 0o600);
  }
}
