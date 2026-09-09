import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActivityPlan,
  ActivitySignal,
  AgentAdapter,
  HostAdapter,
  OpenPlan,
  CheckoutRequest,
  StartRequest,
  StartableAgent,
  OpenRequest,
  OpenRoute,
  ReadFailure,
  MachineReaders,
  Session,
  SessionActivity,
} from '@ground-control/core';
import type { LogEntry, LogFloor, Logger } from '@ground-control/core';
import { makeLogger } from '../src/logger.js';

/** Collect entries through watch. Hub construction applies stored logLevel, so tests requiring debug entries must configure it on the hub. */
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

/** Use isolated homes so tests cannot overwrite the developer's shared hub state. */
export function tempHome(): { home: string; dispose: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'gc-hub-'));

  return { home, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

export interface FakeSignal extends ActivitySignal {
  /** What `plan` was handed, so a test can prove the settings text reached the adapter rather than being assumed. */
  planned: { settingsText: string | null; wanted: 'install' | 'remove' }[];
}

/** Fake adapter plans isolate generic installation, filesystem, and lock behavior from agent-specific merging. */
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
    // Use separate settings files so multi-agent tests distinguish each installation.
    settingsPath: (home) => `${home}/.${id}/settings.json`,
    watchDir: (home) => `${home}/.claude/ground-control/activity-${id}`,
    read: () => null,
    writer: { path: (home) => `${home}/.claude/ground-control/${id}-writer.mjs`, source: 'the writer\n' },
  };
}

/** Default to empty filesystem readers; detection tests provide the required directories. */
export function fakeReaders(dirs: Record<string, string[]> = {}, home = '/home/dev'): MachineReaders {
  return {
    readText: () => null,
    mtime: () => null,
    listDir: (path) => dirs[path] ?? null,
    readTail: () => null,
    readHead: () => null,
    home,
  };
}

export function fakeAgent(id: string, activity?: ActivitySignal): AgentAdapter {
  return {
    id,
    displayName: id,
    defaultPath: `${id}-cli`,
    enabledByDefault: () => true,
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

/** Inject roster and phase results without spawning CLIs or reading real markers. */
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
      enabledByDefault: () => true,
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
    attachId: null,
    details: {},
    ...over,
  };
}

export interface FakeHostControl {
  adapter: HostAdapter;
  plan: OpenPlan;
  /** Every request the hub built, so what it puts in one is asserted rather than assumed. */
  planned: OpenRequest[];
  /** The same, for a route to a card's checkout rather than to a session. */
  checkoutPlan: OpenPlan;
  checkoutsPlanned: CheckoutRequest[];
  /** The same again, for a new session on a card. */
  startPlan: OpenPlan;
  startsPlanned: StartRequest[];
  /** The agents this host offers a start for, which is what a client's snapshot carries. */
  startableAgents: StartableAgent[];
  /** Routes performed by a resident client; an empty list lets the hub perform them. */
  resident: OpenRoute['route'][];
  performed: OpenRoute[];
  primed: number;
}

export function fakeHost(id = 'fake-host'): FakeHostControl {
  const control: FakeHostControl = {
    plan: { refusal: 'unknown-session', message: 'nothing to open' },
    planned: [],
    checkoutPlan: { route: 'open-checkout', key: 'issue:1', root: 'd:/checkouts/project-1', newWindow: false },
    checkoutsPlanned: [],
    startPlan: { route: 'start-session', key: 'issue:1', agent: 'claude', root: 'd:/checkouts/project-1', prompt: null },
    startsPlanned: [],
    startableAgents: [{ agent: 'claude', takesPrompt: true }],
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
      planCheckout: (request) => {
        control.checkoutsPlanned.push(request);

        return control.checkoutPlan;
      },
      planStart: (request) => {
        control.startsPlanned.push(request);

        return control.startPlan;
      },
      startable: () => control.startableAgents,
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
