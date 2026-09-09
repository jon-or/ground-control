import { statSync } from 'node:fs';
import { PROTOCOL } from '@ground-control/core';
import { findHub, stopThisHub } from './discover.js';
import type { Found, HubMiss, LiveHub } from './discover.js';
import { read } from './fs.js';
import { bundlePathOf, exitPathOf, hubJsonPathOf, logPathOf } from './paths.js';

/** Shared hub discovery and startup dependencies for both clients (R35). */
export interface EnsureDeps {
  home: string;
  /** Starts a hub for this home and returns; the caller waits for `hub.json` rather than for the process. */
  start(): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Probe once for identity and connection failure details. */
  look(home: string): Promise<Found>;
  /** Request authenticated shutdown of a specific hub, including an older bundle or protocol. */
  stop(hub: LiveHub): Promise<boolean>;
  /** Whether the bundle file is newer than the running hub record. */
  bundleIsNewer(): boolean;
}

export type Ensured = { hub: LiveHub } | { failed: string };

/** Startup measured 85–96 ms (M25); allow five seconds for slower machines. */
export const START_TIMEOUT_MS = 5000;
export const START_POLL_MS = 100;

/** Limit consecutive unsuccessful starts. A successful connection resets the budget. */
export const STARTS_PER_MINUTE = 1;
export const STARTS_PER_FIVE_MINUTES = 3;
const MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 5 * MINUTE_MS;

/** Read the last recorded orderly exit. Forced termination leaves no exit record (M25), but absence alone does not establish the cause. */
function lastExit(home: string): string {
  const text = read(exitPathOf(home));

  if (text === null) {
    return 'No exit reason recorded.';
  }

  try {
    const parsed = JSON.parse(text) as { reason?: unknown };

    return typeof parsed.reason === 'string' ? `Last exit reason: ${parsed.reason}.` : 'No exit reason recorded.';
  } catch {
    return 'No exit reason recorded.';
  }
}

function withExitDetails(home: string, what: string): string {
  return `${what} ${lastExit(home)} Log: ${logPathOf(home)}.`;
}

/** Read the port recorded by a duplicate-instance startup refusal. */
function duplicateHubPort(home: string): string | null {
  const text = read(exitPathOf(home));
  const found = text === null ? null : /already serving this home on port (\d+)/.exec(text);

  return found?.[1] ?? null;
}

/** Include a recorded duplicate-instance refusal in the connection error. */
function duplicateHubDetails(home: string): string {
  const port = duplicateHubPort(home);

  return port === null
    ? ''
    : ` Another hub is already running for this home on port ${port}, but this window cannot connect to it.`;
}

/** Describe the final discovery failure and available recovery steps. Report a PID only when identity was verified. */
function discoveryFailure(home: string, miss: HubMiss): string {
  if (miss.why === 'no-record') {
    return withExitDetails(home, 'The hub started but did not respond.');
  }

  // Report a PID only for an authenticated listener; an old record may reference a reused PID.
  const held = miss.why === 'another-protocol' ? miss.hub.record : miss.record;
  const stop = `Stop that process and open the board again.`;

  switch (miss.why) {
    case 'unreachable':
      return withExitDetails(home, 'Could not connect to the recorded hub.');

    case 'silent':
      return `The process on recorded hub port ${held.port} did not respond. ${stop}${duplicateHubDetails(home)}`;

    case 'not-a-hub':
      return `Port ${held.port} answered, but not as Ground Control (HTTP ${miss.saw.status}${miss.saw.said === '' ? '' : `: ${miss.saw.said}`}), and ${hubJsonPathOf(home)} still names it. Stop that process, or delete that file, and open the board again.${duplicateHubDetails(home)}`;

    case 'another-home':
      return `The hub on port ${held.port} is tracking a different home, and this board cannot use it. ${stop}${duplicateHubDetails(home)}`;

    case 'unproven':
      return `Could not verify the authentication token for the hub on port ${held.port}. ${stop}${duplicateHubDetails(home)}`;

    case 'another-protocol':
      return `Another hub version is running (pid ${held.pid}, port ${held.port}) and did not stop. ${stop}`;
  }
}

/** Share concurrent startup attempts and keep a restart budget per client. */
export function makeEnsure(deps: EnsureDeps): () => Promise<Ensured> {
  const started: number[] = [];

  let inFlight: Promise<Ensured> | undefined;

  /** Prune expired attempts and check both restart limits. */
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
      // Keep the current hub if the restart budget would prevent its replacement.
      if (!mayStart(now)) {
        return { hub: found.hub };
      }

      // Another client may have replaced the hub. Recheck discovery before falling back to the current connection.
      if (!(await deps.stop(found.hub))) {
        const again = await deps.look(deps.home);

        return { hub: 'hub' in again ? again.hub : found.hub };
      }
    } else {
      const mismatch = await resolveProtocolMismatch(deps, found.miss);

      if (mismatch) {
        return mismatch;
      }

      if (!mayStart(now)) {
        return { failed: withExitDetails(deps.home, 'The hub repeatedly exited after starting.') };
      }
    }

    started.push(now);

    try {
      deps.start();
    } catch (error) {
      return { failed: `Could not start the hub: ${String(error)}` };
    }

    // Include probe duration in the startup deadline; summing sleeps could extend it by minutes.
    for (const until = deps.now() + START_TIMEOUT_MS; deps.now() < until; ) {
      await deps.sleep(START_POLL_MS);

      const live = await deps.look(deps.home);

      if ('hub' in live) {
        started.length = 0;

        // A successful connection resets the consecutive-failure budget.
        return { hub: live.hub };
      }
    }

    // Probe again to distinguish a startup failure from an existing hub that refused this client.
    const last = await deps.look(deps.home);

    // Accept a hub that became available after the polling deadline.
    if ('hub' in last) {
      started.length = 0;

      return { hub: last.hub };
    }

    return { failed: discoveryFailure(deps.home, last.miss) };
  }

  return () => {
    inFlight ??= attempt().finally(() => {
      inFlight = undefined;
    });

    return inFlight;
  };
}

/** Replace an authenticated older-protocol hub. Refuse to replace a newer-protocol hub. */
async function resolveProtocolMismatch(deps: EnsureDeps, miss: HubMiss): Promise<Ensured | null> {
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

/** Compare bundle and hub-record mtimes from the same filesystem to avoid mixing clock sources. */
export function bundleIsNewer(home: string): boolean {
  const written = mtimeOf(bundlePathOf(home));
  const bound = mtimeOf(hubJsonPathOf(home));

  return written !== null && bound !== null && bound < written;
}

/** Return null for missing or unreadable files; neither establishes bundle freshness. */
function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Probe the recorded port and use the client-supplied startup function. */
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
