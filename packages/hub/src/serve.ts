import { appendFileSync, closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { PROTOCOL, groundControlDirOf } from '@ground-control/core';
import { writeAtomic } from './fs.js';
import { Hub, realHubDeps } from './hub.js';
import { makeLaneStore } from './lanes.js';
import { makeMarkStore } from './marks.js';
import { makeSettingsStore } from './settings.js';
import { openLog } from './log.js';
import { exitPathOf, hubJsonPathOf, logPathOf } from './paths.js';
import { makeRegistries } from './registry.js';
import { fingerprintOf, readHubRecord, recordedHub } from './discover.js';
import type { LiveHub } from './discover.js';
import { createHubServer } from './server.js';
import type { HubServer } from './server.js';
import { watchDir } from './watch.js';

/**
 * What a hub must not inherit. VS Code spawns it as its own executable running as node, and `VSCODE_IPC_HOOK` then
 * names the window that started it to every CLI the hub spawns (`mechanics.md` §26).
 */
export function sanitizeEnvironment(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = Object.keys(env).filter(
    (key) => key.startsWith('ELECTRON_') || key.startsWith('VSCODE_') || key === 'NODE_OPTIONS',
  );

  for (const key of removed) {
    delete env[key];
  }

  return removed;
}

/**
 * The environment a hub or a bridge is started in. Sanitized, and then `ELECTRON_RUN_AS_NODE` put back: the
 * interpreter may be VS Code's own executable, which runs as node only when told to and otherwise opens an editor.
 * Plain node ignores the variable, so one environment serves both and no caller has to know which it holds.
 */
export function spawnEnvironment(env: NodeJS.ProcessEnv = { ...process.env }): NodeJS.ProcessEnv {
  sanitizeEnvironment(env);
  env['ELECTRON_RUN_AS_NODE'] = '1';

  return env;
}

/** A hub reading the given home, wired to the real machine. The same object whether it is served or held in process. */
export function makeHub(home: string = homedir()): Hub {
  return new Hub(
    realHubDeps(makeRegistries(), makeLaneStore(home), makeMarkStore(home), makeSettingsStore(home), home, watchDir),
  );
}

/** Half an hour with nobody connected. The next board open starts one again in about a second (R35). */
export const IDLE_EXIT_MS = 30 * 60 * 1000;

export interface ServeOptions {
  home?: string;
  version: string;
  idleMs?: number;
  /** Where the hub's own lines go. Defaults to `hub.log`, appended, rotated once at startup. */
  log?: (line: string) => void;
  /** How the process ends. Injected so a test drives the idle rule without ending the runner. */
  exit?: (code: number) => void;
}

export interface Served {
  port: number;
  token: string;
  hub: Hub;
  /** The hub's own line writer, so an entry point reports a crash where the rest of the hub's story is. */
  log(line: string): void;
  stop(reason: string): Promise<void>;
}

/** Either this process is now the hub, or another one already is and this one has nothing to do. */
export type ServeResult = { served: Served } | { existing: LiveHub };

function fileLogger(home: string): (line: string) => void {
  const fd = openLog(logPathOf(home));

  return (line) => {
    try {
      appendFileSync(fd, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // A log that cannot be written is not a reason to stop tracking.
    }
  };
}

/**
 * Claims this home for this process. Exclusive create rather than a plain write: two hubs racing each other both
 * bind — `listen(0)` cannot collide, so binding decides nothing — and the second overwriting the first would leave
 * two live hubs polling, both rewriting `lanes.json` whole.
 */
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

/**
 * Starts the hub for a home, unless one is already answering for it. Two things decide that, in order: a probe of
 * the recorded port before binding, and an exclusive create of `hub.json` after. A record whose port answers as
 * nothing is a hub that was killed, which is the normal state on Windows (`mechanics.md` §25) and is taken over.
 */
export async function serveHub(options: ServeOptions): Promise<ServeResult> {
  const home = options.home ?? homedir();
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const idleMs = Number.isFinite(options.idleMs) ? (options.idleMs as number) : IDLE_EXIT_MS;

  sanitizeEnvironment();
  mkdirSync(groundControlDirOf(home), { recursive: true });

  const log = options.log ?? fileLogger(home);
  // Any hub, not just one this build can talk to: two of them polling one home both rewrite `lanes.json` whole.
  // Which protocol wins is a client's decision, made before it spawns anything, by stopping the one it displaces.
  const already = await recordedHub(home);

  if (already) {
    log(`a hub is already serving this home on port ${already.record.port}; nothing to do`);

    return { existing: already };
  }

  const fingerprint = fingerprintOf(home);
  const hub = makeHub(home);
  const startedAt = new Date().toISOString();

  let server: HubServer;
  let stopping: Promise<void> | undefined;
  let idle: NodeJS.Timeout | undefined;

  /** Only if the record still describes this process: an orphan must never delete the record of the hub that won. */
  const unclaim = (): void => {
    if (readHubRecord(home)?.pid === process.pid) {
      rmSync(hubJsonPathOf(home), { force: true });
    }
  };

  const stop = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      log(`stopping: ${reason}`);
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
  });

  try {
    server = await created.listen();
  } catch (error) {
    hub.dispose();

    const reason = `could not listen on 127.0.0.1: ${String(error)}`;

    // Written here too, or a client whose spawn never came up quotes the reason the last hub stopped for.
    log(reason);
    writeAtomic(exitPathOf(home), JSON.stringify({ code: 1, at: new Date().toISOString(), reason }, null, 2));

    // Nothing to retry on port 0: a failure here is the loopback interface, not a port someone else took.
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
        throw new Error(`Another process keeps claiming ${hubJsonPathOf(home)} and none of them is answering.`);
      }

      log(`another hub claimed this home first, on port ${other.record.port}; standing down`);

      return { existing: other };
    }

    // The record names a hub that is not answering, which is what a killed one leaves behind.
    rmSync(hubJsonPathOf(home), { force: true });
  }

  rmSync(exitPathOf(home), { force: true });

  // Best effort only: a process killed on Windows runs nothing (`mechanics.md` §25), which is why every client's
  // liveness check is the probe rather than this file.
  process.on('exit', unclaim);

  idle = setInterval(() => {
    const since = server.emptySince();

    if (since !== null && Date.now() - since >= idleMs) {
      void stop('nobody has been watching').then(() => exit(0));
    }
  }, Math.max(200, Math.min(60_000, idleMs)));
  idle.unref();

  log(`listening on 127.0.0.1:${server.port} as pid ${process.pid}`);

  return { served: { port: server.port, token: server.token, hub, log, stop } };
}
