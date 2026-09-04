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
