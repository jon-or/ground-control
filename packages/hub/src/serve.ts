import { closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { PROTOCOL, dirKey, resolveStateDir } from '@ground-control/core';
import type { ResolvedStateDir } from '@ground-control/core';
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

/** Construct a hub with real machine dependencies for the given home and state directory. */
export function makeHub(log: Logger, home: string = homedir(), stateDir: string = resolveStateDir(home).stateDir, agentEnv?: NodeJS.ProcessEnv): Hub {
  return new Hub(
    realHubDeps(makeRegistries(log, home, agentEnv, stateDir), makeLaneStore(stateDir), makeMarkStore(stateDir), makeSettingsStore(stateDir), home, stateDir, watchDir, log),
  );
}

/** Exit after 30 minutes without clients; opening a board starts a new hub (R35). */
export const IDLE_EXIT_MS = 30 * 60 * 1000;

export interface ServeOptions {
  home?: string;
  /** Default: the home's pointer, or its bootstrap directory. */
  stateDir?: string;
  /** Explicit environments allow profile fixtures; an injected home otherwise ignores agent home variables. */
  agentEnv?: NodeJS.ProcessEnv;
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

/** Report whether this process started the hub, found an existing one, or refused to start during a state relocation. */
export type ServeResult = { served: Served } | { existing: LiveHub } | { refused: string };

/** Why a hub must not serve the resolved directory, or null. */
function pointerRefusal(resolved: ResolvedStateDir): string | null {
  if (resolved.problem !== null) {
    return `${resolved.problem} Fix or delete the pointer in the bootstrap directory.`;
  }

  return resolved.migratingTo === null ? null : `state relocation to ${resolved.migratingTo} in progress`;
}

/** Record duplicate-instance startup refusal for client diagnostics. */
function recordDuplicateHub(stateDir: string, port: number): void {
  const reason = `a hub was already serving this state directory on port ${port}`;

  writeAtomic(exitPathOf(stateDir), JSON.stringify({ code: 0, at: new Date().toISOString(), reason }, null, 2));
}

/** Exclusively create hub.json after binding. Ephemeral ports do not prevent two hubs from starting for the same directory. */
function claimRecord(stateDir: string, text: string): boolean {
  try {
    const fd = openSync(hubJsonPathOf(stateDir), 'wx');

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
  const resolved = resolveStateDir(home);
  const stateDir = options.stateDir ?? resolved.stateDir;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const idleMs = Number.isFinite(options.idleMs) ? (options.idleMs as number) : IDLE_EXIT_MS;

  sanitizeEnvironment();
  mkdirSync(stateDir, { recursive: true });

  // A client is moving this directory, or the pointer is unusable; serving would split state between locations.
  const refusal = options.stateDir === undefined ? pointerRefusal(resolved) : null;

  if (refusal !== null) {
    writeAtomic(exitPathOf(stateDir), JSON.stringify({ code: 0, at: new Date().toISOString(), reason: refusal }, null, 2));

    return { refused: refusal };
  }

  const log = options.log ?? makeLogger({ write: fileSink(stateDir) });

  // Respect authenticated hubs with any protocol to prevent duplicate writers. Clients decide whether to replace incompatible hubs.
  const already = await recordedHub(stateDir);

  if (already) {
    log.info(`hub already running for this state directory on port ${already.record.port}`);
    recordDuplicateHub(stateDir, already.record.port);

    return { existing: already };
  }

  const fingerprint = fingerprintOf(stateDir);
  const hub = makeHub(log, home, stateDir, options.agentEnv ?? (options.home === undefined ? process.env : undefined));
  const startedAt = new Date().toISOString();

  let server: HubServer;
  let stopping: Promise<void> | undefined;
  let idle: NodeJS.Timeout | undefined;

  /** Remove the record only if it still belongs to this process. */
  const unclaim = (): void => {
    if (readHubRecord(stateDir)?.pid === process.pid) {
      rmSync(hubJsonPathOf(stateDir), { force: true });
    }
  };

  const stop = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      log.info(`stopping: ${reason}`);
      clearInterval(idle);
      await server.close();
      hub.dispose();
      unclaim();
      writeAtomic(exitPathOf(stateDir), JSON.stringify({ code: 0, at: new Date().toISOString(), reason }, null, 2));
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
    writeAtomic(exitPathOf(stateDir), JSON.stringify({ code: 1, at: new Date().toISOString(), reason }, null, 2));

    // Port zero cannot conflict; binding failure indicates a loopback problem.
    throw new Error(`The hub ${reason}`);
  }

  // Discovery and binding took time; a move recorded meanwhile must not be crossed by claiming the old directory.
  const again = options.stateDir === undefined ? resolveStateDir(home) : null;
  const late = again === null ? null : (pointerRefusal(again) ?? (dirKey(again.stateDir) === dirKey(stateDir) ? null : `the state directory moved to ${again.stateDir} during startup`));

  if (late !== null) {
    await server.close();
    hub.dispose();
    log.info(`not serving: ${late}`);
    writeAtomic(exitPathOf(stateDir), JSON.stringify({ code: 0, at: new Date().toISOString(), reason: late }, null, 2));

    return { refused: late };
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

  for (let attempts = 2; !claimRecord(stateDir, text); attempts--) {
    const other = await recordedHub(stateDir);

    if (other || attempts === 1) {
      await server.close();
      hub.dispose();

      if (!other) {
        throw new Error(`The hub record at ${hubJsonPathOf(stateDir)} repeatedly changed, but no recorded hub responded.`);
      }

      log.info(`another hub started for this state directory on port ${other.record.port}; exiting`);
      recordDuplicateHub(stateDir, other.record.port);

      return { existing: other };
    }

    // Replace the record for an unresponsive hub.
    rmSync(hubJsonPathOf(stateDir), { force: true });
  }

  rmSync(exitPathOf(stateDir), { force: true });

  // Forced Windows termination skips cleanup (M25); clients must probe for liveness instead of trusting this file.
  process.on('exit', unclaim);

  idle = setInterval(() => {
    const since = server.emptySince();

    if (since !== null && Date.now() - since >= idleMs) {
      void stop('nobody has been watching').then(() => exit(0));
    }
  }, Math.max(200, Math.min(60_000, idleMs)));
  idle.unref();

  log.info(`listening on 127.0.0.1:${server.port} as pid ${process.pid}, state in ${stateDir}`);

  return { served: { port: server.port, token: server.token, hub, log, stop } };
}
