import { mkdirSync } from 'node:fs';
import { groundControlDirOf } from '@ground-control/core';
import { EMPTY_MEMORY, readMemory } from '@ground-control/board';
import type { CardMemory } from '@ground-control/board';
import { read, writeAtomic } from './fs.js';
import { lanesPathOf } from './paths.js';

/**
 * Where the developer put each card, as a file rather than as one board's own storage. R8 says a card sits in
 * exactly one lane, and two boards with two memories would put one card in two — so this is one record per machine,
 * and every client reads it through the snapshot.
 */
export interface LaneStore {
  read(statuses: readonly string[]): CardMemory;
  write(memory: CardMemory): void;
}

export function makeLaneStore(home: string): LaneStore {
  const path = lanesPathOf(home);

  return {
    read(statuses: readonly string[]): CardMemory {
      const text = read(path);

      if (text === null) {
        return { ...EMPTY_MEMORY, statuses: [...statuses] };
      }

      // A file the developer can hand-edit, so an unparsed read of it is a board that throws on every render with
      // no way back but deleting it. `readMemory` already refuses a stored value it cannot use.
      try {
        return readMemory(JSON.parse(text), statuses);
      } catch {
        return { ...EMPTY_MEMORY, statuses: [...statuses] };
      }
    },

    write(memory: CardMemory): void {
      try {
        mkdirSync(groundControlDirOf(home), { recursive: true });
        writeAtomic(path, `${JSON.stringify(memory, null, 2)}\n`);
      } catch {
        // A placement that could not be stored is one the developer makes again. Failing the render is worse.
      }
    },
  };
}
