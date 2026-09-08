import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActivityPlan,
  ActivitySignal,
  AgentAdapter,
  HostAdapter,
  OpenPlan,
  OpenRequest,
  OpenRoute,
  ReadFailure,
  Session,
  SessionActivity,
} from '@ground-control/core';
import type { LogEntry, LogFloor, Logger } from '@ground-control/core';
import { makeLogger } from '../src/logger.js';

/**
 * A logger a test reads back, collected through `watch` — the same subscription a board opening a viewer makes.
 *
 * The floor here is only the floor until a `Hub` is built over it: its constructor applies the stored
 * configuration, whose `logLevel` is `info` by default. A test that wants the hub's `debug` lines configures
 * the hub for them rather than passing a floor here.
 */
export function captureLog(level: LogFloor = 'debug'): { log: Logger; entries: LogEntry[]; messages: string[] } {
  const entries: LogEntry[] = [];
  const messages: string[] = [];
  const log = makeLogger({ write: () => {}, level });

  log.watch((entry) => {
    entries.push(entry);
    messages.push(entry.message);
  });

  return { log, entries, messages };
}

/**
 * A home of the hub's own, never the developer's. Every module here writes into `~/.claude/ground-control`, and a
 * test that reached the real one would delete a running board's lane placements.
 */
export function tempHome(): { home: string; dispose: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'gc-hub-'));

  return { home, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

export interface FakeSignal extends ActivitySignal {
  /** What `plan` was handed, so a test can prove the settings text reached the adapter rather than being assumed. */
  planned: { settingsText: string | null; wanted: 'install' | 'remove' }[];
}

/**
 * An activity signal with no agent behind it. The install is generic — it does the file system and the lock, and
 * every decision is the adapter's — so a fake is what proves that rather than Claude's own hook merge.
 */
export function fakeSignal(
  plan: ActivityPlan | ((wanted: 'install' | 'remove') => ActivityPlan),
  id = 'fake',
): FakeSignal {
  const planned: FakeSignal['planned'] = [];

  return {
    planned,
    plan({ settingsText, wanted }) {
      planned.push({ settingsText, wanted });

      return typeof plan === 'function' ? plan(wanted) : plan;
    },
    // Named for the agent: two signals in one run must not share a settings file, or a test cannot tell an install
    // of its own from an install of the other agent's.
    settingsPath: (home) => `${home}/.${id}/settings.json`,
    watchDir: (home) => `${home}/.claude/ground-control/activity-${id}`,
    read: () => null,
    writer: { path: (home) => `${home}/.claude/ground-control/${id}-writer.mjs`, source: 'the writer\n' },
  };
}

export function fakeAgent(id: string, activity?: ActivitySignal): AgentAdapter {
  return {
    id,
    displayName: id,
    defaultPath: `${id}-cli`,
    defaultEnabled: true,
    ...(activity ? { activity } : {}),
    async listSessions() {
      return { sessions: [], failure: null };
    },
  };
}

export interface FakeAgentControl {
  adapter: AgentAdapter;
  /** How many times the CLI was asked. What proves a marker event cost a file read rather than a spawn. */
  calls: number;
  sessions: Session[];
  failure: ReadFailure | null;
  /** The path each read was made with, so a configured CLI path is proved to reach the adapter. */
  paths: string[];
  /** Set to hold a read open, so a test can deliver an event while one is genuinely in flight. */
  holding: Promise<void> | null;
  /** What each session's marker reports now, keyed by id. Absent is a session claiming no phase. */
  phases: Map<string, SessionActivity>;
}

/** An agent whose roster and phases a test sets directly, so nothing here spawns anything or reads a real marker. */
export function reportingAgent(id = 'fake'): FakeAgentControl {
  const control: FakeAgentControl = {
    calls: 0,
    sessions: [],
    failure: null,
    paths: [],
    holding: null,
    phases: new Map(),
    adapter: {
      id,
      displayName: id,
      defaultPath: `${id}-cli`,
      defaultEnabled: true,
      activity: {
        plan: () => ({ kind: 'up-to-date' }),
        settingsPath: (home) => `${home}/.fake/settings.json`,
        watchDir: (home) => `${home}/.fake/activity`,
        read: (_home, sessionId) => control.phases.get(sessionId) ?? null,
      },
      async listSessions(path: string) {
        control.calls += 1;
        control.paths.push(path);

        if (control.holding) {
          const held = control.holding;
          control.holding = null;
          await held;
        }

        return { sessions: control.sessions.map((session) => ({ ...session })), failure: control.failure };
      },
    },
  };

  return control;
}

export function fakeSession(over: Partial<Session> = {}): Session {
  return {
    agent: 'fake',
    sessionId: 'a1b2c3d4-0000-4000-8000-000000000000',
    pid: 4242,
    title: 'the session',
    cwd: 'd:/checkouts/project-1',
    checkoutRoot: 'd:/checkouts/project-1',
    startedAt: 1_788_000_000_000,
    branch: '18941-inbox-badge',
    repository: 'github.com/example-org/example-repo',
    issueNumber: 18941,
    transcriptWrittenAt: null,
    activity: null,
    finished: false,
    details: {},
    ...over,
  };
}

export interface FakeHostControl {
  adapter: HostAdapter;
  plan: OpenPlan;
  /** Every request the hub built, so what it puts in one is asserted rather than assumed. */
  planned: OpenRequest[];
  /** Routes this host would rather the client performed. Empty makes every route the hub's own to carry out. */
  resident: OpenRoute['route'][];
  performed: OpenRoute[];
  primed: number;
}

export function fakeHost(id = 'fake-host'): FakeHostControl {
  const control: FakeHostControl = {
    plan: { refusal: 'unknown-session', message: 'nothing to open' },
    planned: [],
    resident: ['reveal-here'],
    performed: [],
    primed: 0,
    adapter: {
      id,
      configure: () => null,
      prime: () => {
        control.primed += 1;
      },
      async windows() {
        return { live: [{ folders: ['d:/checkouts/project-1'] }], holding: null };
      },
      async surfaces() {
        return [];
      },
      plan: (request) => {
        control.planned.push(request);

        return control.plan;
      },
      openable: (sessions) => sessions.map((session) => session.sessionId),
      get residentRoutes() {
        return control.resident;
      },
      async open(route) {
        control.performed.push(route);

        return 'opened';
      },
    },
  };

  return control;
}

/** A clock a test drives. Nothing here waits: an interval is fired by naming the cadence it was registered at. */
export function fakeClock(start = 1_788_000_000_000) {
  let now = start;
  let next = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();

  return {
    clock: {
      now: () => now,
      setInterval(fn: () => void, ms: number) {
        const handle = next++;
        timers.set(handle, { fn, ms });

        return handle as unknown as NodeJS.Timeout;
      },
      clearInterval(handle: NodeJS.Timeout) {
        timers.delete(handle as unknown as number);
      },
    },
    advance: (ms: number) => {
      now += ms;
    },
    cadences: () => [...timers.values()].map((timer) => timer.ms).sort((a, b) => a - b),
    /** Which timers these are, not merely how they are paced: a rebuilt one restarts the clock it was counting. */
    handles: () => [...timers.keys()],
    /** Time passes before a timer of that cadence fires, as it does on a real clock: floors count elapsed time. */
    fire: (ms: number) => {
      now += ms;

      for (const timer of [...timers.values()]) {
        if (timer.ms === ms) {
          timer.fn();
        }
      }
    },
  };
}
