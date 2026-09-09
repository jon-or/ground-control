import { CODEX_DISPLAY_NAME } from './ids.js';
import { trustEditFor } from './trust.js';

/** What one attempt to have Codex trust the board's hooks came to. `null` is the attempt having worked. */
export type TrustAttempt = string | null;

/** What to do with one message Codex sent: send the next request, answer, or neither. */
export type TrustStep = { send: unknown } | { answer: TrustAttempt } | null;

const INITIALIZE = 1;
const LIST = 2;
const WRITE = 3;

/** The ids this exchange asked under. A reply to anything else is Codex talking about something else. */
const MINE = new Set<unknown>([INITIALIZE, LIST, WRITE]);

interface Reply {
  id?: unknown;
  result?: unknown;
  error?: { message?: string };
}

/**
 * The three-request conversation that trusts the board's own hooks, as a decision per reply. Pure, so the sequencing
 * and every way it ends are testable without a process: the spawn in `appServer.ts` only moves bytes.
 *
 * `initialize`, then `hooks/list` for the hash Codex would trust per entry, then one `config/batchWrite` handing
 * those hashes back. The board computes no hash and writes no TOML (`docs/mechanics.md` M41).
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

      if (!MINE.has(reply.id)) {
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

        // Codex read a hooks file that is not the one the board wrote into. Answering this as success would hide the
        // one fault that looks exactly like a working install and changes nothing.
        if (plan.ours === 0) {
          return { answer: `${CODEX_DISPLAY_NAME} reported none of the board's own hooks` };
        }

        // Nothing left to trust: an install that is already done, or another window's attempt that got there first.
        if (plan.edit === null) {
          return { answer: null };
        }

        return { send: { id: WRITE, method: 'config/batchWrite', params: { edits: [plan.edit] } } };
      }

      return { answer: null };
    },
  };
}
