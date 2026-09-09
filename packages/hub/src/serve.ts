import { closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { PROTOCOL, groundControlDirOf } from '@ground-control/core';
import { writeAtomic } from './fs.js';
import { Hub, realHubDeps } from './hub.js';
import { makeLaneStore } from './lanes.js';
import { makeMarkStore } from './marks.js';
import { makeSettingsStore } from './settings.js';
import { fileSink, makeLogger } from './logger.js';
import { exitPathOf, hubJsonPathOf } from './paths.js';
import { makeRegistries } from './registry.js';
import { fingerprintOf, readHubRecord, recordedHub } from './discover.js';
import type { LiveHub } from './discover.js';
import { createHubServer } from './server.js';
import type { HubServer } from './server.js';
import { watchDir } from './watch.js';
import type { Logger } from '@ground-control/core';

/** Remove VS Code window/build environment variables so child CLIs do not target the originating window or build (M26, M49). */
export function sanitizeEnvironment(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = Object.keys(env).filter(
    (key) => key.startsWith('ELECTRON_') || key.startsWith('VSCODE_') || key === 'NODE_OPTIONS',
  );

  for (const key of removed) {
    delete env[key];
  }

  return removed;
}

/** Sanitize child environments, then set ELECTRON_RUN_AS_NODE so a VS Code executable acts as Node. Plain Node ignores it. */
export function spawnEnvironment(env: NodeJS.ProcessEnv = { ...process.env }): NodeJS.ProcessEnv {
  sanitizeEnvironment(env);
  env['ELECTRON_RUN_AS_NODE'] = '1';

  return env;
}

/** Construct a hub with real machine dependencies for the given home. */
export function makeHub(log: Logger, home: string = homedir()): Hub {
  return new Hub(
    realHubDeps(makeRegistries(log, home), makeLaneStore(home), makeMarkStore(home), makeSettingsStore(home), home, watchDir, log),
  );
}

/** Exit after 30 minutes without clients; opening a board starts a new hub (R35). */
export const IDLE_EXIT_MS = 30 * 60 * 1000;

export interface ServeOptions {
  home?: string;
  version: string;
  idleMs?: number;
  /** Default log: hub.log, appended and rotated at startup. */
  log?: Logger;
  /** Inject process exit to test idle shutdown. */
  exit?: (code: number) => void;
}

export interface Served {
  port: number;
  token: string;
  hub: Hub;
  /** Shared logger for entry-point errors. */
  log: Logger;
  stop(reason: string): Promise<void>;
}

/** Report whether this process started the hub or found an existing one. */
export type ServeResult = { served: Served } | { existing: LiveHub };

/** Record duplicate-instance startup refusal for client diagnostics. */
function recordDuplicateHub(home: string, port: number): void {
  const reason = `a hub was already serving this home on port ${port}`;

  writeAtomic(exitPathOf(home), JSON.stringify({ code: 0, at: new Date().toISOString(), reason }, null, 2));
}

/** Exclusively create hub.json after binding. Ephemeral ports do not prevent two hubs from starting for the same home. */
function claimRecord(home: string, text: string): boolean {
  try {
    const fd = openSync(hubJsonPathOf(home), 'wx');

    writeSync(fd, text);
    closeSync(fd);

    return true;
  } catch {
    return false;
  }
}

/** Probe for an existing hub, then bind and exclusively create hub.json. Replace records only when their hub no longer answers (M25). */
export async function serveHub(options: ServeOptions): Promise<ServeResult> {
  const home = options.home ?? homedir();
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const idleMs = Number.isFinite(options.idleMs) ? (options.idleMs as number) : IDLE_EXIT_MS;

  sanitizeEnvironment();
  mkdirSync(groundControlDirOf(home), { recursive: true });

  const log = options.log ?? makeLogger({ write: fileSink(home) });
  // Respect authenticated hubs with any protocol to prevent duplicate writers. Clients decide whether to replace incompatible hubs.
  const already = await recordedHub(home);

  if (already) {
    log.info(`hub already running for this home on port ${already.record.port}`);
    recordDuplicateHub(home, already.record.port);

    return { existing: already };
  }

  const fingerprint = fingerprintOf(home);
  const hub = makeHub(log, home);
  const startedAt = new Date().toISOString();

  let server: HubServer;
  let stopping: Promise<void> | undefined;
  let idle: NodeJS.Timeout | undefined;

  /** Remove the record only if it still belongs to this process. */
  const unclaim = (): void => {
    if (readHubRecord(home)?.pid === process.pid) {
      rmSync(hubJsonPathOf(home), { force: true });
    }
  };

  const stop = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      log.info(`stopping: ${reason}`);
      clearInterval(idle);
      await server.close();
      hub.dispose();
      unclaim();
      writeAtomic(exitPathOf(home), JSON.stringify({ code: 0, at: new Date().toISOString(), reason }, null, 2));
    })();

    return stopping;
  };

  const created = createHubServer({
    hub,
    fingerprint,
    onShutdown: () => void stop('a client asked it to stop').then(() => exit(0)),
    log,
  });

  try {
    server = await created.listen();
  } catch (error) {
    hub.dispose();

    const reason = `could not listen on 127.0.0.1: ${String(error)}`;

    // Record startup failure so clients do not report an earlier hub's exit reason.
    log.error(reason);
    writeAtomic(exitPathOf(home), JSON.stringify({ code: 1, at: new Date().toISOString(), reason }, null, 2));

    // Port zero cannot conflict; binding failure indicates a loopback problem.
    throw new Error(`The hub ${reason}`);
  }

  const text = JSON.stringify(
    {
      protocol: PROTOCOL,
      version: options.version,
      port: server.port,
      token: server.token,
      pid: process.pid,
      startedAt,
      fingerprint,
    },
    null,
    2,
  );

  for (let attempts = 2; !claimRecord(home, text); attempts--) {
    const other = await recordedHub(home);

    if (other || attempts === 1) {
      await server.close();
      hub.dispose();

      if (!other) {
        throw new Error(`The hub record at ${hubJsonPathOf(home)} repeatedly changed, but no recorded hub responded.`);
      }

      log.info(`another hub started for this home on port ${other.record.port}; exiting`);
      recordDuplicateHub(home, other.record.port);

      return { existing: other };
    }

    // Replace the record for an unresponsive hub.
    rmSync(hubJsonPathOf(home), { force: true });
  }

  rmSync(exitPathOf(home), { force: true });

  // Forced Windows termination skips cleanup (M25); clients must probe for liveness instead of trusting this file.
  process.on('exit', unclaim);

  idle = setInterval(() => {
    const since = server.emptySince();

    if (since !== null && Date.now() - since >= idleMs) {
      void stop('nobody has been watching').then(() => exit(0));
    }
  }, Math.max(200, Math.min(60_000, idleMs)));
  idle.unref();

  log.info(`listening on 127.0.0.1:${server.port} as pid ${process.pid}`);

  return { served: { port: server.port, token: server.token, hub, log, stop } };
}
