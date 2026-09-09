import { CODEX_DISPLAY_NAME } from './ids.js';
import { trustEditFor } from './trust.js';

/** Hook trust error, or null on success. */
export type TrustAttempt = string | null;

/** Response action: send the next request, return the result, or ignore the message. */
export type TrustStep = { send: unknown } | { answer: TrustAttempt } | null;

const INITIALIZE = 1;
const LIST = 2;
const WRITE = 3;

/** Request IDs used by the trust exchange. */
const REQUEST_IDS = new Set<unknown>([INITIALIZE, LIST, WRITE]);

interface Reply {
  id?: unknown;
  result?: unknown;
  error?: { message?: string };
}

/**
 * Process hook trust replies without starting a process. Send `initialize`, get Codex hashes from `hooks/list`,
 * then return them through `config/batchWrite`. Codex computes hashes and writes TOML; `appServer.ts` handles
 * transport (M41).
 */
export function trustExchange(home: string): { start(): unknown; take(reply: unknown): TrustStep } {
  return {
    start() {
      return {
        id: INITIALIZE,
        method: 'initialize',
        params: { clientInfo: { name: 'ground-control', version: '0.0.0' }, capabilities: { experimentalApi: true } },
      };
    },

    take(raw) {
      const reply = raw as Reply;

      if (!REQUEST_IDS.has(reply.id)) {
        return null;
      }

      if (reply.error) {
        return { answer: reply.error.message ?? `${CODEX_DISPLAY_NAME} refused the request` };
      }

      if (reply.id === INITIALIZE) {
        return { send: { id: LIST, method: 'hooks/list', params: {} } };
      }

      if (reply.id === LIST) {
        const plan = trustEditFor(reply.result, home);

        // No matching hooks indicates Codex read a different hooks file; do not report success.
        if (plan.ours === 0) {
          return { answer: `${CODEX_DISPLAY_NAME} reported none of the board's own hooks` };
        }

        // The hooks are already trusted, possibly by another window.
        if (plan.edit === null) {
          return { answer: null };
        }

        return { send: { id: WRITE, method: 'config/batchWrite', params: { edits: [plan.edit] } } };
      }

      return { answer: null };
    },
  };
}
