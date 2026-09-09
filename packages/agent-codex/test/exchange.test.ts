import { describe, expect, it } from 'vitest';
import { trustExchange } from '../src/exchange.js';
import type { TrustStep } from '../src/exchange.js';
import { codexHooksPathOf, hookPathOf } from '../src/hookScript.js';
import { HOME } from './helpers.js';

const HOOKS_FILE = codexHooksPathOf(HOME);
const OURS = `node "${hookPathOf(HOME)}"`;

function sent(step: TrustStep): { id?: unknown; method?: unknown; params?: unknown } {
  if (step === null || 'answer' in step) {
    throw new Error(`expected a request, got ${JSON.stringify(step)}`);
  }

  return step.send as { id?: unknown; method?: unknown; params?: unknown };
}

function listing(hooks: unknown[]): unknown {
  return { id: 2, result: { data: [{ hooks }] } };
}

function hook(trustStatus: string, command = OURS, currentHash: string | null = 'sha256:abc'): unknown {
  return { key: `${HOOKS_FILE}:stop:0:0`, command, currentHash, trustStatus };
}

describe('the trust exchange', () => {
  it('opens with an initialize that names the client and asks for the experimental API', () => {
    const start = trustExchange(HOME).start() as { method: string; params: { clientInfo: { name: string }; capabilities: { experimentalApi: boolean } } };

    expect(start.method).toBe('initialize');
    expect(start.params.clientInfo.name).toBe('ground-control');
    expect(start.params.capabilities.experimentalApi).toBe(true);
  });

  it('asks for the hooks once Codex has answered the initialize', () => {
    expect(sent(trustExchange(HOME).take({ id: 1, result: {} })).method).toBe('hooks/list');
  });

  it('upserts reported hashes while preserving existing trust', () => {
    const exchange = trustExchange(HOME);
    exchange.take({ id: 1, result: {} });

    const write = sent(exchange.take(listing([hook('untrusted')])));

    expect(write.method).toBe('config/batchWrite');
    expect(write.params).toEqual({
      edits: [
        {
          keyPath: 'hooks.state',
          mergeStrategy: 'upsert',
          value: { [`${HOOKS_FILE}:stop:0:0`]: { trusted_hash: 'sha256:abc' } },
        },
      ],
    });
  });

  it('completes after the write acknowledgment', () => {
    expect(trustExchange(HOME).take({ id: 3, result: { status: 'ok' } })).toEqual({ answer: null });
  });

  it('completes without writing when all hooks are trusted', () => {
    expect(trustExchange(HOME).take(listing([hook('trusted')]))).toEqual({ answer: null });
  });

  /** A wrong Codex home can report no board hooks; this must not count as successful trust. */
  it('fails when no board hooks are reported', () => {
    const step = trustExchange(HOME).take(listing([hook('untrusted', 'powershell mine.ps1')]));

    expect(step).toEqual({ answer: "Codex reported none of the board's own hooks" });
  });

  it('fails when the hook listing is empty', () => {
    expect(trustExchange(HOME).take(listing([]))).toEqual({ answer: "Codex reported none of the board's own hooks" });
  });

  it('answers with what Codex refused, on whichever request it refused', () => {
    expect(trustExchange(HOME).take({ id: 2, error: { message: 'unknown method' } })).toEqual({ answer: 'unknown method' });
    expect(trustExchange(HOME).take({ id: 3, error: {} })).toEqual({ answer: 'Codex refused the request' });
  });

  /** Ignore replies and notifications unrelated to trust request IDs. */
  it('ignores replies outside the trust request IDs', () => {
    expect(trustExchange(HOME).take({ method: 'thread/started', params: {} })).toBeNull();
    expect(trustExchange(HOME).take({ id: 99, result: {} })).toBeNull();
  });
});
