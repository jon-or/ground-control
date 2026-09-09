// @ts-check
/**
 * Browser state logic, independent of Chrome APIs for unit testing.
 *
 * @typedef {import('@ground-control/core').Snapshot} Snapshot
 * @typedef {{ snapshot: Snapshot | null, trouble: string | null, notice: string | null }} State
 */

/** @returns {State} */
export function initialState() {
  return { snapshot: null, trouble: 'Waiting for the Ground Control hub.', notice: null };
}

/**
 * Update state from worker messages. Only the worker clears trouble: cached snapshots do not establish a live
 * connection (R24).
 *
 * @param {State} state
 * @param {{ type?: string, snapshot?: Snapshot, message?: string | null }} message
 * @returns {State}
 */
export function applyMessage(state, message) {
  if (message.type === 'snapshot' || message.type === 'changed') {
    return { ...state, snapshot: message.snapshot ?? null };
  }

  if (message.type === 'trouble') {
    return { ...state, trouble: message.message ?? null };
  }

  // Display the latest action result, including browser permission refusals.
  if (message.type === 'notice') {
    return { ...state, notice: message.message ?? null };
  }

  return state;
}

/**
 * Exponential reconnect delay from one to thirty seconds, matching the editor transport.
 *
 * @param {number} attempt
 * @returns {number}
 */
export function retryDelay(attempt) {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Retry stopped workers. An extension reload invalidates existing content scripts; missing chrome.runtime.id
 * requires a page reload.
 *
 * @param {{ id?: string } | undefined} runtime
 * @returns {{ retry: boolean, trouble: string }}
 */
export function disconnection(runtime) {
  return runtime?.id === undefined
    ? { retry: false, trouble: 'Ground Control was reloaded. Reload this tab to restore the overlay.' }
    : { retry: true, trouble: 'The overlay lost its connection to Ground Control.' };
}

/**
 * Retain more than twice the hub 64 KB backfill at its minimum line size (about 35 bytes), allowing space for
 * browser logs too.
 */
export const LOG_LIMIT = 4000;

/**
 * Track log subscribers and buffer lines for newly opened sidebars. Only the first subscriber and last
 * unsubscribe change the hub subscription. Keys are opaque worker ports; state decisions remain testable
 * outside worker.js.
 *
 * @typedef {{ at: string, level: string, source: string, scope?: string, message: string }} LogEntry
 * @param {number} [limit]
 */
export function makeLogSpool(limit = LOG_LIMIT) {
  /** @type {Set<unknown>} */
  const open = new Set();
  /** @type {LogEntry[]} */
  let lines = [];

  return {
    /** @returns {readonly LogEntry[]} */
    held: () => lines,
    /** The tabs to send a line to. The only record of them, so the worker cannot hold one this has forgotten. */
    viewers: () => open,
    watching: () => open.size > 0,

    /**
     * Retain local browser logs without a viewer so opening the sidebar includes events preceding a failure.
     *
     * @param {readonly LogEntry[]} entries
     */
    hold(entries) {
      lines.push(...entries);

      if (lines.length > limit) {
        lines = lines.slice(lines.length - limit);
      }
    },

    /**
     * Return a hub subscription change only for the first open or last close. Additional viewers receive the
     * buffered backlog without requesting another hub backfill.
     *
     * @param {unknown} key
     * @param {boolean} wanted
     * @returns {{ tell: boolean | null, backlog: readonly LogEntry[] }}
     */
    view(key, wanted) {
      if (wanted === open.has(key)) {
        return { tell: null, backlog: [] };
      }

      if (wanted) {
        const backlog = lines;

        open.add(key);

        return { tell: open.size === 1 ? true : null, backlog };
      }

      open.delete(key);

      if (open.size > 0) {
        return { tell: null, backlog: [] };
      }

      // Drop hub history when the last sidebar closes; reopening fetches a fresh tail and would otherwise
      // duplicate it.
      lines = lines.filter((entry) => entry.source !== 'hub');

      return { tell: false, backlog: [] };
    },
  };
}
