import { existsSync, mkdirSync } from 'node:fs';
import { EMPTY_ACTIONS } from '@ground-control/core';
import type { ActionHistoryEntry, ActionState } from '@ground-control/core';
import { readActionHistory, readActionState } from '@ground-control/automation';
import { readCached, writeIfChanged } from './fs.js';
import { actionHistoryPathOf, actionsPathOf } from './paths.js';

/** Persist card action state. Reread on access, via `readCached`, to preserve manual edits and avoid restoring stale run records. */
export interface ActionStore {
  read(): ActionState;
  /** A failed write disables further dispatches. */
  write(state: ActionState): boolean;
}

export function makeActionStore(stateDir: string): ActionStore {
  const path = actionsPathOf(stateDir);

  return {
    read(): ActionState {
      const text = readCached(path);

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
        mkdirSync(stateDir, { recursive: true });
        writeIfChanged(path, `${JSON.stringify(state, null, 2)}\n`);

        return true;
      } catch {
        return false;
      }
    },
  };
}

/** The action history (R50). A failed write loses entries, not dispatch safety, so it is logged and ignored. */
export interface ActionHistoryStore {
  /** Null where the file exists but cannot be read, so a writer does not replace a history it could not see. */
  read(): ActionHistoryEntry[] | null;
  write(entries: readonly ActionHistoryEntry[]): boolean;
}

export function makeActionHistoryStore(stateDir: string): ActionHistoryStore {
  const path = actionHistoryPathOf(stateDir);

  return {
    read(): ActionHistoryEntry[] | null {
      if (!existsSync(path)) {
        return [];
      }

      const text = readCached(path);

      if (text === null) {
        return null;
      }

      try {
        const stored: unknown = JSON.parse(text);

        return Array.isArray((stored as { entries?: unknown } | null)?.entries) ? readActionHistory(stored) : null;
      } catch {
        return null;
      }
    },

    write(entries: readonly ActionHistoryEntry[]): boolean {
      try {
        mkdirSync(stateDir, { recursive: true });
        writeIfChanged(path, `${JSON.stringify({ entries }, null, 2)}\n`);

        return true;
      } catch {
        return false;
      }
    },
  };
}
