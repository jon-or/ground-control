import { mkdirSync } from 'node:fs';
import { groundControlDirOf } from '@ground-control/core';
import type { TriageState } from '@ground-control/core';
import { readTriageState } from '@ground-control/board';
import { read, writeIfChanged } from './fs.js';
import { triagePathOf } from './paths.js';

/**
 * What the board has read about each card, as a file rather than as one hub's memory. Re-read on every access the
 * way the lane store is: a developer can hand-edit this, and a copy held in memory would overwrite their edit on the
 * next reading without ever having looked at it.
 */
export interface TriageStore {
  read(): TriageState;
  write(state: TriageState): boolean;
}

export function makeTriageStore(home: string): TriageStore {
  const path = triagePathOf(home);

  return {
    read(): TriageState {
      const text = read(path);

      if (text === null) {
        return { entries: {}, failures: {} };
      }

      try {
        return readTriageState(JSON.parse(text));
      } catch {
        // An unparsable file reads as empty, which re-reads the board. `readTriageState` already drops one bad entry
        // at a time, so reaching here means the file is not JSON at all.
        return { entries: {}, failures: {} };
      }
    },

    write(state: TriageState): boolean {
      try {
        mkdirSync(groundControlDirOf(home), { recursive: true });
        // Infinity is not JSON. A card that has spent its attempts stores the largest finite instant instead, which
        // is the same "not again on its own" without a null appearing where a number belongs.
        writeIfChanged(path, `${JSON.stringify(state, finite, 2)}\n`);

        return true;
      } catch {
        // A reading that could not be stored is one the board takes again. Failing the render is worse.
        return false;
      }
    },
  };
}

function finite(_key: string, value: unknown): unknown {
  return value === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : value;
}
