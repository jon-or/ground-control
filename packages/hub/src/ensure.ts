import { PROTOCOL } from '@ground-control/core';
import { liveHub, recordedHub, stopHub } from './discover.js';
import type { LiveHub } from './discover.js';
import { read } from './fs.js';
import { exitPathOf, logPathOf } from './paths.js';

/**
 * How a client gets a hub: find the one this home already has, or start one. Shared by every client, because
 * starting a background process is the part that must behave the same whichever board asked for it (R35).
 */
export interface EnsureDeps {
  home: string;
  /** Starts a hub for this home and returns; the caller waits for `hub.json` rather than for the process. */
  start(): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** How the hub already running is found. Injected so a test drives the wait without a listener. */
  find(home: string): Promise<LiveHub | null>;
  /** The same, ignoring the protocol: what is running may be a hub this client cannot speak to. */
  findAny(home: string): Promise<LiveHub | null>;
  /** Stops a hub of another protocol so this client's own can take the home. */
  stop(home: string): Promise<boolean>;
}

export type Ensured = { hub: LiveHub } | { failed: string };

/** Startup was 85–96 ms measured (`mechanics.md` §25), so this is a wide margin over a cold, loaded machine. */
export const START_TIMEOUT_MS = 5000;
export const START_POLL_MS = 100;

/**
 * Consecutive starts that never answered. A hub that came up resets the count, so a developer who kills a working
 * one gets it back at once; only a hub that will not start at all is what this stops making forever.
 */
export const STARTS_PER_MINUTE = 1;
export const STARTS_PER_FIVE_MINUTES = 3;
const MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 5 * MINUTE_MS;

/** Why the last hub stopped, when it stopped in an orderly way. Its absence says it was killed (`mechanics.md` §25). */
function lastExit(home: string): string {
  const text = read(exitPathOf(home));

  if (text === null) {
    return 'It left no reason behind, which is what a killed process leaves.';
  }

  try {
    const parsed = JSON.parse(text) as { reason?: unknown };

    return typeof parsed.reason === 'string' ? `It last stopped because ${parsed.reason}.` : 'It left no reason behind.';
  } catch {
    return 'It left no reason behind.';
  }
}

function tellThem(home: string, what: string): string {
  return `${what} ${lastExit(home)} Its log is at ${logPathOf(home)}.`;
}

/**
 * One `ensure` per client, holding its own restart budget. Concurrent callers share the one attempt: a window with a
 * board and a settings listener asks twice at once, and two starts would race for the same record.
 */
export function makeEnsure(deps: EnsureDeps): () => Promise<Ensured> {
  const started: number[] = [];

  let inFlight: Promise<Ensured> | undefined;

  async function attempt(): Promise<Ensured> {
    const found = await deps.find(deps.home);

    if (found) {
      return { hub: found };
    }

    const mismatch = await outOfStep(deps);

    if (mismatch) {
      return mismatch;
    }

    const now = deps.now();

    while (started.length > 0 && now - started[0]! > FIVE_MINUTES_MS) {
      started.shift();
    }

    if (
      started.filter((at) => now - at <= MINUTE_MS).length >= STARTS_PER_MINUTE ||
      started.length >= STARTS_PER_FIVE_MINUTES
    ) {
      return { failed: tellThem(deps.home, 'The board keeps starting its background process and it keeps stopping.') };
    }

    started.push(now);

    try {
      deps.start();
    } catch (error) {
      return { failed: `The board could not start its background process: ${String(error)}` };
    }

    for (let waited = 0; waited < START_TIMEOUT_MS; waited += START_POLL_MS) {
      await deps.sleep(START_POLL_MS);

      const live = await deps.find(deps.home);

      if (live) {
        started.length = 0;

        // It came up, so nothing before this was a hub that will not start. What the budget counts is the run of
        // starts that answered nothing, which is the only shape worth refusing to try again.
        return { hub: live };
      }
    }

    return { failed: tellThem(deps.home, 'The board started its background process and it never answered.') };
  }

  return () => {
    inFlight ??= attempt().finally(() => {
      inFlight = undefined;
    });

    return inFlight;
  };
}

/**
 * A hub is running that this client cannot talk to. Newer wins, the same rule the bundle on disk follows: this client
 * stops it and starts its own. An older one has nothing to start — the bundle it would run is the newer hub's — so
 * it says so rather than spawning a process that stands down and calling that "it never answered".
 */
async function outOfStep(deps: EnsureDeps): Promise<Ensured | null> {
  const other = await deps.findAny(deps.home);

  if (other === null) {
    return null;
  }

  if (other.identity.protocol > PROTOCOL) {
    return {
      failed: `A newer Ground Control is already tracking this machine. Update this window's extension, or close the other one.`,
    };
  }

  await deps.stop(deps.home);

  return null;
}

/** The real one: the hub is found by probing the recorded port, and started by whatever the client knows how to run. */
export function realEnsureDeps(home: string, start: () => void): EnsureDeps {
  return {
    home,
    start,
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    find: (where) => liveHub(where),
    findAny: (where) => recordedHub(where),
    stop: (where) => stopHub(where),
  };
}
