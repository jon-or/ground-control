import { mkdirSync } from 'node:fs';
import { EMPTY_ACTIONS, groundControlDirOf } from '@ground-control/core';
import type { ActionState } from '@ground-control/core';
import { readActionState } from '@ground-control/automation';
import { read, writeIfChanged } from './fs.js';
import { actionsPathOf } from './paths.js';

/**
 * What the board has run on each card, as a file rather than as one hub's memory. Re-read on every access the way
 * the lane and triage stores are: forgetting a run is what makes a card eligible for another, so a copy held in
 * memory would overwrite a developer's own edit without ever having looked at it.
 */
export interface ActionStore {
  read(): ActionState;
  /** False where the state could not be stored, which the runner treats as a reason to stop starting work. */
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
        // A file that is not JSON at all reads as no runs, and that is a fail-open the runner has to close: no runs
        // means no gates, no ledger and every card eligible again. It is reported as such by the write that follows
        // — the runner rewrites the state on every pass, so an unreadable file becomes an unwritable one or is
        // replaced. `readActionState` already drops one bad entry at a time, so reaching here is the whole file.
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
