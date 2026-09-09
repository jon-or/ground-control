import { spawn } from 'node:child_process';
import { resolveOnDisk } from '@ground-control/core';
import { trustExchange } from './exchange.js';
import type { TrustAttempt } from './exchange.js';
import { codexHomeOf } from './hookScript.js';

/** Trust the installed board hooks. Return an error message on failure; never throw. */
export type TrustHooks = (codexPath: string, home: string, env?: NodeJS.ProcessEnv) => Promise<TrustAttempt>;

/** Timeout for app-server startup and the three trust requests, normally completed in about one second. */
const TIMEOUT_MS = 20_000;

/**
 * Run Codex's hook-trust exchange over app-server JSON-RPC stdio. trustExchange selects requests; this module
 * handles transport. Trust only entries matching the installed Ground Control writer command, preserving user
 * and plugin hooks.
 */
export function makeTrustOnMachine(env: NodeJS.ProcessEnv = process.env): TrustHooks {
  return function trustHooks(codexPath, home, environment = env) {
    const selected = { ...environment, CODEX_HOME: codexHomeOf(home, environment) };
    const resolved = resolveOnDisk(codexPath);

    if (resolved === null) {
      return Promise.resolve(`no Codex executable at "${codexPath}"`);
    }

    return new Promise<TrustAttempt>((resolve) => {
      const exchange = trustExchange(home);
      let child: ReturnType<typeof spawn>;

      try {
        // Use the resolved Codex home for both hook reads and app-server: ~/.codex or CODEX_HOME.
        child = spawn(resolved, ['app-server'], {
          env: selected,
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        });
      } catch (error) {
        // A resolved shim path can still cause spawn to throw synchronously.
        resolve((error as Error).message);

        return;
      }

      let settled = false;
      let partialLine = '';

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
      // Fail immediately if the server exits before replying.
      child.on('exit', () => answer('Codex stopped before it answered'));

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        const lines = (partialLine + chunk).split('\n');
        // Retain the incomplete final line for the next chunk.
        partialLine = lines.pop() ?? '';

        for (const line of lines) {
          if (line.trim().length === 0) {
            continue;
          }

          let reply: unknown;

          try {
            reply = JSON.parse(line);
          } catch {
            // Ignore non-JSON output; trustExchange filters unrelated JSON messages.
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
