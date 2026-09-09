import { mkdirSync } from 'node:fs';
import { groundControlDirOf } from '@ground-control/core';
import { EMPTY_MEMORY, readMemory } from '@ground-control/board';
import type { CardMemory } from '@ground-control/board';
import { read, writeIfChanged } from './fs.js';
import { lanesPathOf } from './paths.js';

/** Share persisted lane placement across clients so each card has one lane per machine (R8). */
export interface LaneStore {
  read(statuses: readonly string[]): CardMemory;
  /** Return whether placement state was stored before callers discard their copy. */
  write(memory: CardMemory): boolean;
}

export function makeLaneStore(home: string): LaneStore {
  const path = lanesPathOf(home);

  return {
    read(statuses: readonly string[]): CardMemory {
      const text = read(path);

      if (text === null) {
        return { ...EMPTY_MEMORY, statuses: [...statuses] };
      }

      // Validate hand-edited state to avoid repeated render failures; readMemory rejects unusable values.
      try {
        return readMemory(JSON.parse(text), statuses);
      } catch {
        return { ...EMPTY_MEMORY, statuses: [...statuses] };
      }
    },

    write(memory: CardMemory): boolean {
      try {
        mkdirSync(groundControlDirOf(home), { recursive: true });
        writeIfChanged(path, `${JSON.stringify(memory, null, 2)}\n`);

        return true;
      } catch {
        // Return failed writes without interrupting rendering.
        return false;
      }
    },
  };
}
