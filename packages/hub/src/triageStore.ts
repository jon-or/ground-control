import { mkdirSync } from 'node:fs';
import { groundControlDirOf } from '@ground-control/core';
import type { TriageState } from '@ground-control/core';
import { readTriageState } from '@ground-control/board';
import { read, writeIfChanged } from './fs.js';
import { triagePathOf } from './paths.js';

/** Persist triage state. Read from disk on every access to preserve manual edits. */
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
        // Invalid JSON resets triage; readTriageState handles invalid entries individually.
        return { entries: {}, failures: {} };
      }
    },

    write(state: TriageState): boolean {
      try {
        mkdirSync(groundControlDirOf(home), { recursive: true });
        // Encode exhausted retries as MAX_SAFE_INTEGER; JSON would convert Infinity to null.
        writeIfChanged(path, `${JSON.stringify(state, finite, 2)}\n`);

        return true;
      } catch {
        // A failed write permits another triage attempt without failing the render.
        return false;
      }
    },
  };
}

function finite(_key: string, value: unknown): unknown {
  return value === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : value;
}
