import { mkdirSync } from 'node:fs';
import { EMPTY_VISITS, readVisits } from '@ground-control/board';
import type { VisitMemory } from '@ground-control/board';
import { readCached, writeIfChanged } from './fs.js';
import { visitsPathOf } from './paths.js';

/** Each card's visits to the board, which the queue view's sections and Done are drawn from (R53). */
export interface VisitStore {
  read(): VisitMemory;
  write(memory: VisitMemory): boolean;
}

export function makeVisitStore(stateDir: string): VisitStore {
  const path = visitsPathOf(stateDir);

  return {
    read(): VisitMemory {
      const text = readCached(path);

      if (text === null) {
        return EMPTY_VISITS;
      }

      try {
        return readVisits(JSON.parse(text));
      } catch {
        return EMPTY_VISITS;
      }
    },

    write(memory: VisitMemory): boolean {
      try {
        mkdirSync(stateDir, { recursive: true });
        writeIfChanged(path, `${JSON.stringify(memory, null, 2)}\n`);

        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Visits kept in memory alone, for a hub given no store. */
export function memoryVisitStore(): VisitStore {
  let held = EMPTY_VISITS;

  return {
    read: () => held,
    write(memory) {
      held = memory;

      return true;
    },
  };
}
