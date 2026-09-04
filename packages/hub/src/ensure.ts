import { statSync } from 'node:fs';
import { PROTOCOL } from '@ground-control/core';
import { findHub, stopThisHub } from './discover.js';
import type { Found, HubMiss, LiveHub } from './discover.js';
import { read } from './fs.js';
import { bundlePathOf, exitPathOf, hubJsonPathOf, logPathOf } from './paths.js';

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
  /**
   * What this home has: the hub, or why there is none. One question rather than one per thing done with the answer,
   * so a client asking whether to connect, to displace, or to give up spends one round trip on all three.
   */
  look(home: string): Promise<Found>;
  /** Stands down one particular hub — one this client cannot speak to, or one running an older bundle than the disk. */
  stop(hub: LiveHub): Promise<boolean>;
  /** Whether the hub on disk was written after the running one started, and is therefore a copy nothing is running. */
  bundleIsNewer(): boolean;
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
 * What a start that came to nothing ran into: no hub at all, a hub that died leaving its record, or — every other
 * branch — a process that is up and did not become this client's hub. The remedy for those is ending it, because
 * nothing stops a hub whose token this client could not prove, and the pid is what the developer has to work with.
 */
function whatIsThere(home: string, miss: HubMiss): string {
  if (miss.why === 'no-record') {
    return tellThem(home, 'The board started its background process and it never answered.');
  }

  // The port comes from the record in every case; the pid only where the listener proved it wrote that record.
  // Anywhere else the record describes a hub that is gone, and its pid may have been handed to something else.
  const held = miss.why === 'another-protocol' ? miss.hub.record : miss.record;
  const stop = `Stop that process and open the board again.`;

  switch (miss.why) {
    case 'unreachable':
      return tellThem(home, 'The board started its background process and it never recorded itself.');

    case 'silent':
      return `Something holds port ${held.port}, which is where this board's hub was, and will not answer this window. ${stop}`;

    case 'not-a-hub':
      return `Port ${held.port} is held by something that is not Ground Control, and ${hubJsonPathOf(home)} still names it. Stop that process, or delete that file, and open the board again.`;

    case 'another-home':
      return `The hub on port ${held.port} is tracking a different home, and this board cannot use it. ${stop}`;

    case 'unproven':
      return `Something is already serving this board's home on port ${held.port}, holding a token this window cannot verify. ${stop}`;

    case 'another-protocol':
      return `A Ground Control of another version is running (pid ${held.pid}, on port ${held.port}) and would not give up this machine. ${stop}`;
  }
}

/**
 * One `ensure` per client, holding its own restart budget. Concurrent callers share the one attempt: a window with a
 * board and a settings listener asks twice at once, and two starts would race for the same record.
 */
export function makeEnsure(deps: EnsureDeps): () => Promise<Ensured> {
  const started: number[] = [];

  let inFlight: Promise<Ensured> | undefined;

  /** Whether another start is one this client is still willing to make, and the pruning of the run it counts. */
  function mayStart(now: number): boolean {
    while (started.length > 0 && now - started[0]! > FIVE_MINUTES_MS) {
      started.shift();
    }

    return (
      started.filter((at) => now - at <= MINUTE_MS).length < STARTS_PER_MINUTE && started.length < STARTS_PER_FIVE_MINUTES
    );
  }

  async function attempt(): Promise<Ensured> {
    const found = await deps.look(deps.home);

    if ('hub' in found && !deps.bundleIsNewer()) {
      return { hub: found.hub };
    }

    const now = deps.now();

    if ('hub' in found) {
      // The budget is asked before the hub is stopped rather than after: a stop this client has no start left to
      // follow would leave the board with nothing at all, which is worse than a board running last week's hub.
      if (!mayStart(now)) {
        return { hub: found.hub };
      }

      // Refused, or already gone — another client's replacement may hold the home by now, and that one is the hub
      // to use. Only if nothing answers is the one just found still the best this client has.
      if (!(await deps.stop(found.hub))) {
        const again = await deps.look(deps.home);

        return { hub: 'hub' in again ? again.hub : found.hub };
      }
    } else {
      const mismatch = await outOfStep(deps, found.miss);

      if (mismatch) {
        return mismatch;
      }

      if (!mayStart(now)) {
        return { failed: tellThem(deps.home, 'The board keeps starting its background process and it keeps stopping.') };
      }
    }

    started.push(now);

    try {
      deps.start();
    } catch (error) {
      return { failed: `The board could not start its background process: ${String(error)}` };
    }

    // Bounded by the clock rather than by the sleeps it adds up: each look can spend its own deadline, and a port
    // held by something that never answers would otherwise stretch a five-second wait into minutes.
    for (const until = deps.now() + START_TIMEOUT_MS; deps.now() < until; ) {
      await deps.sleep(START_POLL_MS);

      const live = await deps.look(deps.home);

      if ('hub' in live) {
        started.length = 0;

        // It came up, so nothing before this was a hub that will not start. What the budget counts is the run of
        // starts that answered nothing, which is the only shape worth refusing to try again.
        return { hub: live.hub };
      }
    }

    // The spawn stands down when anything is already serving the home and says so only in its own log, so from
    // here a hub that turned this client away and a hub that never started are the same silence.
    const last = await deps.look(deps.home);

    // A hub that turned up while this was giving up on it. Rare, and the board is better off connected to it than
    // told about a race it cannot see.
    if ('hub' in last) {
      started.length = 0;

      return { hub: last.hub };
    }

    return { failed: whatIsThere(deps.home, last.miss) };
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
async function outOfStep(deps: EnsureDeps, miss: HubMiss): Promise<Ensured | null> {
  if (miss.why !== 'another-protocol') {
    return null;
  }

  if (miss.hub.identity.protocol > PROTOCOL) {
    return {
      failed: `A newer Ground Control is already tracking this machine. Update this window's extension, or close the other one.`,
    };
  }

  await deps.stop(miss.hub);

  return null;
}

/**
 * Whether the hub on disk was written after the running hub started, which makes what is running an older copy of
 * itself. Both times are file times from the one filesystem — the bundle against the record the hub wrote as it
 * bound — because a clock the times come from and a clock they are compared on must be the same one.
 */
export function bundleIsNewer(home: string): boolean {
  const written = mtimeOf(bundlePathOf(home));
  const bound = mtimeOf(hubJsonPathOf(home));

  return written !== null && bound !== null && bound < written;
}

/** Null for a file that is not there, and for one this process may not stat: neither says a hub is out of date. */
function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** The real one: the hub is found by probing the recorded port, and started by whatever the client knows how to run. */
export function realEnsureDeps(home: string, start: () => void): EnsureDeps {
  return {
    home,
    start,
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    look: (where) => findHub(where),
    stop: (hub) => stopThisHub(hub),
    bundleIsNewer: () => bundleIsNewer(home),
  };
}
