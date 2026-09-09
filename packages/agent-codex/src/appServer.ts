import { spawn } from 'node:child_process';
import { resolveOnDisk } from '@ground-control/core';
import { trustExchange } from './exchange.js';
import type { TrustAttempt } from './exchange.js';
import { codexHomeOf } from './hookScript.js';

/** Asks Codex to trust the hooks the board installed under `home`. Never throws; every failure is its own sentence. */
export type TrustHooks = (codexPath: string, home: string) => Promise<TrustAttempt>;

/**
 * How long the whole exchange may take. `codex app-server` starts, answers three requests and is killed — measured
 * at about a second, so this is the budget for a Codex that has stopped answering rather than a normal one.
 */
const TIMEOUT_MS = 20_000;

/**
 * Run Codex's hook-trust exchange over app-server JSON-RPC stdio. trustExchange selects requests; this module
 * handles transport. Trust only entries matching the installed Ground Control writer command, preserving user
 * and plugin hooks.
 */
export function makeTrustOnMachine(env: NodeJS.ProcessEnv = process.env): TrustHooks {
  return function trustHooks(codexPath, home) {
    const resolved = resolveOnDisk(codexPath);

    if (resolved === null) {
      return Promise.resolve(`no Codex executable at "${codexPath}"`);
    }

    return new Promise<TrustAttempt>((resolve) => {
      const exchange = trustExchange(home);
      let child: ReturnType<typeof spawn>;

      try {
        // Codex's own home, not the board's: the caller passes the home every other read is made under, and the
        // hooks file this exchange is about is the one `codexHomeOf` resolves — `~/.codex`, or `$CODEX_HOME`.
        child = spawn(resolved, ['app-server'], {
          env: { ...env, CODEX_HOME: codexHomeOf(home, env) },
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        });
      } catch (error) {
        // `spawn` throws synchronously for a shim Node will not run, which a resolved path can still be.
        resolve((error as Error).message);

        return;
      }

      let settled = false;
      let held = '';

      const answer = (attempt: TrustAttempt): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill();
          resolve(attempt);
        }
      };

      const timer = setTimeout(() => answer(`${resolved} did not answer within ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS);
      const send = (message: unknown): void => {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      };

      child.on('error', (error) => answer(error.message));
      // A server that exits before answering leaves nothing to wait for, and the timeout would cost the full budget.
      child.on('exit', () => answer('Codex stopped before it answered'));

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        const lines = (held + chunk).split('\n');
        // The last element is whatever Codex has written since its last newline, which is not a message yet.
        held = lines.pop() ?? '';

        for (const line of lines) {
          if (line.trim().length === 0) {
            continue;
          }

          let reply: unknown;

          try {
            reply = JSON.parse(line);
          } catch {
            // Codex writes notifications of its own that no request asked for; a line this cannot read is not ours.
            continue;
          }

          const step = exchange.take(reply);

          if (step === null) {
            continue;
          }

          if ('answer' in step) {
            answer(step.answer);

            return;
          }

          send(step.send);
        }
      });

      send(exchange.start());
    });
  };
}
