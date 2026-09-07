// @ts-check
/**
 * The browser client's decisions, held apart from the two files that hold a `chrome` port so vitest can reach them.
 * What is left in `content.js` and `worker.js` is wiring: connect, observe, relay.
 *
 * @typedef {import('@ground-control/core').Snapshot} Snapshot
 * @typedef {{ snapshot: Snapshot | null, trouble: string | null, notice: string | null }} State
 */

/**
 * The pages the overlay paints. The content script is injected across github.com rather than on these alone,
 * because reaching a board by clicking through the site is a soft navigation and Chrome injects nothing for one —
 * so the match has to be made here, again, every time the location changes.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isBoardPath(pathname) {
  return /^\/(orgs|users)\/[^/]+\/projects\/[^/]+/.test(pathname);
}

/** @returns {State} */
export function initialState() {
  return { snapshot: null, trouble: 'Ground Control has not answered yet.', notice: null };
}

/**
 * What one message from the worker does to what the overlay draws. `trouble` is the worker's to set and clear, not
 * something a snapshot clears on arrival: a snapshot replayed from storage is a real reading and an old one, and a
 * tab that cleared the line on receiving it would look current while nothing was answering (R24).
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

  // The answer to something the developer just did — an action refused, or one the hub could not carry out. Held
  // until the next one, because a browser tab has nowhere else to put it.
  if (message.type === 'notice') {
    return { ...state, notice: message.message ?? null };
  }

  return state;
}

/**
 * Doubling from a second to half a minute — the same shape the editor's transport uses, for the same reason.
 *
 * @param {number} attempt
 * @returns {number}
 */
export function retryDelay(attempt) {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * How many lines the spool holds. Over twice what the hub's 64 KB backfill can carry at its shortest line — the ISO
 * timestamp alone puts a floor near 35 bytes — so a sidebar opening beside a spool already holding the browser's
 * own half does not drop part of what the hub has just sent.
 */
export const LOG_LIMIT = 4000;

/**
 * Which board tabs have a log sidebar open, and the lines to hand the next one that does. Here rather than in
 * `worker.js` because the two moments that decide whether the hub is read at all live here — the first sidebar
 * opening and the last one closing — and the worker is not a file vitest can reach.
 *
 * Keys are opaque; the worker passes its own ports.
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
     * Kept whether or not a sidebar is open when they are the browser's own — nothing about those leaves this
     * process, so a developer opening the panel after the overlay went quiet gets the lines that led there.
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
     * One tab's sidebar opening or closing. `tell` is what the hub has to be told, and it is only ever set on the
     * first open and the last close: telling it again would have it backfill, and every other sidebar would show
     * the tail of the file a second time. `backlog` is what this tab is handed instead, and it is handed over
     * before the tab counts as watching, so a line the subscription itself writes arrives once rather than twice.
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

      // The hub's half goes with the last sidebar. Opening one again is answered with a fresh tail of `hub.log`, so
      // keeping this copy would show that history twice — and nothing of the hub's is held longer than a viewer is.
      lines = lines.filter((entry) => entry.source !== 'hub');

      return { tell: false, backlog: [] };
    },
  };
}
