import { mkdirSync } from 'node:fs';
import { EMPTY_ACTIONS, groundControlDirOf } from '@ground-control/core';
import type { ActionState } from '@ground-control/core';
import { readActionState } from '@ground-control/automation';
import { read, writeIfChanged } from './fs.js';
import { actionsPathOf } from './paths.js';

/** Persist card action state. Reread on access to preserve manual edits and avoid restoring stale run records. */
export interface ActionStore {
  read(): ActionState;
  /** A failed write disables further dispatches. */
  write(state: ActionState): boolean;
}

export function makeActionStore(home: string): ActionStore {
  const path = actionsPathOf(home);

  return {
    read(): ActionState {
      const text = read(path);

      if (text === null) {
        return EMPTY_ACTIONS;
      }

      try {
        return readActionState(JSON.parse(text));
      } catch {
        // Invalid JSON returns empty state, losing recorded limits and retry gates. The next write replaces it or fails and disables dispatch. Invalid entries are filtered separately.
        return EMPTY_ACTIONS;
      }
    },

    write(state: ActionState): boolean {
      try {
        mkdirSync(groundControlDirOf(home), { recursive: true });
        writeIfChanged(path, `${JSON.stringify(state, null, 2)}\n`);

        return true;
      } catch {
        return false;
      }
    },
  };
}
