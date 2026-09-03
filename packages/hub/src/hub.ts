import { assignLanes, mergeBoard, nextMemory, withPlacement } from '@ground-control/board';
import { fetchAssignedIssues } from '@ground-control/github';
import type { AssignedIssues, GithubConfig, Result } from '@ground-control/github';
import { diskReaders, fetchSessions, parseHubConfig, rosterIsStale, unreportedSessions } from '@ground-control/core';
import type {
  ActivityChange,
  ClientHello,
  ClientMessage,
  HubConfig,
  HubMessage,
  LaneId,
  MachineReaders,
  Lane,
  ReadFailure,
  Session,
  SessionsSnapshot,
  Snapshot,
} from '@ground-control/core';
import { activityNotice, pruneMarkers, syncActivity } from './activityInstall.js';
import type { ActivityState } from './activityInstall.js';
import { read } from './fs.js';
import type { LaneStore } from './lanes.js';
import { afterInstall, announce } from './marks.js';
import type { MarkStore } from './marks.js';
import { configureHosts, defaultConfig } from './registry.js';
import type { Registries } from './registry.js';
import { readGithubConfig } from './sources.js';

/** Injected whole, so a test drives the two cadences without waiting for them. */
export interface HubClock {
  now(): number;
  setInterval(fn: () => void, ms: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
}

export interface HubDeps {
  clock: HubClock;
  watch(dir: string, onChange: (changes: readonly ActivityChange[]) => void): { dispose(): void };
  /** The home every read outside a workspace is made under. Injected, so a test never touches the developer's own. */
  home: string;
  registries: Registries;
  lanes: LaneStore;
  marks: MarkStore;
  /** Whose issues these are, when the configuration names nobody. Seeded from the CLI's own login (R26, R28). */
  detectLogins(ghPath: string): Promise<string[]>;
  /** Reads the work items. One function until `WorkSource` arrives, which is the same read behind a registry. */
  readIssues(config: GithubConfig): Promise<Result<AssignedIssues>>;
  /** The activity install, which is also the thing a test replaces to keep its hands off any settings file. */
  syncActivity(registries: Registries, wanted: 'install' | 'remove', home: string): ActivityState;
}

/** A connected board. The hub never holds the transport, only what to call to reach it. */
export interface Client {
  readonly id: string;
}

interface Connected {
  hello: ClientHello;
  send(message: HubMessage): void;
  watching: boolean;
}

/** A refresh asked for again inside this is the same read. The button, not the timers, is what this is for. */
const REFRESH_FLOOR_MS = 1000;

const REAL_CLOCK: HubClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
};

export function realHubDeps(
  registries: Registries,
  lanes: LaneStore,
  marks: MarkStore,
  home: string,
  watch: HubDeps['watch'],
  detectLogins: HubDeps['detectLogins'],
): HubDeps {
  return {
    clock: REAL_CLOCK,
    watch,
    home,
    registries,
    lanes,
    marks,
    detectLogins,
    readIssues: (config) => fetchAssignedIssues(config),
    syncActivity: (regs, wanted, where) => syncActivity(regs.agents, wanted, where),
  };
}

/**
 * The tracking every board is a client of. It polls the sources, watches the activity signal, remembers where the
 * developer put each card, and hands out one snapshot. It owns what a board needs to render and act on, and no work
 * item's own state — moving a card in GitHub Projects is not its business (R7).
 *
 * One instance per machine. Polling runs only while a client is watching, because a hidden board and a closed
 * browser tab both cost the same CLI spawns as a visible one (R35).
 */
export class Hub {
  readonly #deps: HubDeps;
  readonly #clients = new Map<string, Connected>();
  readonly #watchers: { dispose(): void }[] = [];
  readonly #timers: NodeJS.Timeout[] = [];

  #config: HubConfig;
  #configFailures: ReadFailure[] = [];

  /** Each source keeps its last good read and its last failure, so one failing never blanks the other (R24). */
  #issues: AssignedIssues | undefined;
  #issuesError: ReadFailure | undefined;
  #sessions: SessionsSnapshot | undefined;
  #issuesInFlight: Promise<void> | undefined;
  #sessionsInFlight: Promise<void> | undefined;
  #lastReadAt = 0;
  /** The last read listed nothing and every agent failed, so an activity event has nothing to re-read. */
  #sessionsUnreadable = false;
  /** The logins the issues on the board were actually read with, which is not the setting the moment it changes. */
  #logins: string[] = [];
  #needsLogins: { detected: string[] } | null = null;
  /** Null until a client has said whether it wants the signal at all. Nothing is written to an agent before that. */
  #activity: ActivityState | null = null;
  #configured = false;
  #installedAt = 0;
  #disposed = false;

  constructor(deps: HubDeps) {
    this.#deps = deps;
    this.#config = defaultConfig(deps.registries);
    pruneMarkers(deps.registries.agents, deps.home);
    this.#armWatchers();
  }

  // — clients —

  connect(hello: ClientHello, send: (message: HubMessage) => void): Client {
    this.#clients.set(hello.id, { hello, send, watching: hello.watching });

    const failure = this.#applyHosts();

    if (failure) {
      this.#configFailures = [failure];
    }

    this.#sendTo(hello.id, 'snapshot');
    this.#retime();

    return { id: hello.id };
  }

  disconnect(client: Client): void {
    this.#clients.delete(client.id);
    this.#retime();
  }

  receive(client: Client, message: ClientMessage): void {
    const connected = this.#clients.get(client.id);

    if (connected === undefined) {
      return;
    }

    switch (message.type) {
      case 'hello':
        connected.hello = message.hello;
        connected.watching = message.hello.watching;
        this.#retime();

        return;

      case 'configure':
        this.configure(message.config);

        return;

      case 'watching':
        connected.watching = message.watching;
        this.#retime();

        // A board coming back shows what is already known before the read it triggers lands.
        if (message.watching) {
          this.#sendTo(client.id, 'snapshot');
          void this.refresh();
        }

        return;

      case 'refresh':
        void this.refresh();

        return;

      case 'move':
        this.#move(message.key, message.lane);

        return;

      case 'open':
        void this.#open(connected, message.sessionId, message.extensionReady);

        return;
    }
  }

  // — configuration —

  /**
   * Takes a client's settings whole. Public because a host may push these without a board open — turning the signal
   * off has to take effect then, or "turn this off to remove those entries" is a claim nothing honours (R34).
   * Returns what the signal install observed, and null when this configuration did not touch it.
   */
  configure(raw: unknown): ActivityState | null {
    const parsed = parseHubConfig(raw);

    // Refused whole, and the board says why. A client is not necessarily this editor, and one field of this becomes
    // a process: taking half of a configuration would leave the hub polling with two clients' settings mixed.
    if ('failure' in parsed) {
      this.#configFailures = [parsed.failure];
      this.#broadcast();

      return null;
    }

    const before = this.#config;

    this.#config = parsed.config;
    this.#configFailures = [];

    const failure = this.#applyHosts();

    if (failure) {
      this.#configFailures = [failure];
    }

    const first = !this.#configured;
    this.#configured = true;

    // The first configuration is what says whether the developer wants the signal at all, so the install waits for
    // it: putting entries in an agent's settings on the hub's own default would write for a developer who turned
    // them off, and then take them away again (R34).
    // Forced, not lazy: `#ensureActivity` keeps a settled run, and a setting that changed is exactly the case
    // where the settled run is the wrong one (R34).
    const changed = first || before.installActivity !== parsed.config.installActivity;
    const resynced = changed ? this.#installActivity() : this.#ensureActivity();

    if (
      before.refreshIntervalMs !== parsed.config.refreshIntervalMs ||
      before.sessionIntervalMs !== parsed.config.sessionIntervalMs
    ) {
      this.#retime();
    }

    void this.refresh();

    return resynced;
  }

  #applyHosts(): ReadFailure | null {
    const failures = configureHosts(this.#deps.registries, this.#config.hosts);

    return failures[0] ?? null;
  }

  /**
   * The signal as this hub last observed it, installing it if it has not been. A `busy` run observed another
   * process's lock and settled nothing, so it is retried rather than kept: a lock a crash left behind would leave
   * this hub reporting no phase for any session, with nothing on screen saying why (R25).
   */
  #ensureActivity(): ActivityState | null {
    return this.#configured && (this.#activity === null || this.#activity.plan === 'busy')
      ? this.#installActivity()
      : this.#activity;
  }

  #installActivity(): ActivityState {
    this.#activity = this.#deps.syncActivity(
      this.#deps.registries,
      this.#config.installActivity ? 'install' : 'remove',
      this.#deps.home,
    );

    return this.#activity;
  }

  // — polling —

  #watched(): boolean {
    return [...this.#clients.values()].some((client) => client.watching);
  }

  /** Timers exist only while something is watching, and are rebuilt when a cadence changes. */
  #retime(): void {
    while (this.#timers.length > 0) {
      this.#deps.clock.clearInterval(this.#timers.pop()!);
    }

    if (this.#disposed || !this.#watched()) {
      return;
    }

    this.#timers.push(
      this.#deps.clock.setInterval(() => void this.#refreshIssues(), this.#config.refreshIntervalMs),
      this.#deps.clock.setInterval(() => void this.#refreshSessions(), this.#config.sessionIntervalMs),
    );
  }

  #armWatchers(): void {
    for (const agent of this.#deps.registries.agents) {
      if (agent.activity) {
        this.#watchers.push(
          this.#deps.watch(agent.activity.watchDir(this.#deps.home), (changes) => this.#onActivity(changes)),
        );
      }
    }
  }

  /**
   * The live roster, read now. The one way anything on this machine reads sessions: a client that spawned the CLI
   * itself would be a second reader of the same machine, which is the thing this process exists to stop.
   */
  async roster(): Promise<readonly Session[]> {
    await this.#refreshSessions();

    return this.#sessions?.sessions ?? [];
  }

  /** Reads both sources. Each coalesces on its own, so a button press and the two timers never stack up. */
  refresh(): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve();
    }

    const now = this.#deps.clock.now();

    if (now - this.#lastReadAt < REFRESH_FLOOR_MS) {
      return Promise.resolve();
    }

    this.#lastReadAt = now;

    return Promise.all([this.#refreshIssues(), this.#refreshSessions()]).then(() => undefined);
  }

  #refreshIssues(): Promise<void> {
    this.#issuesInFlight ??= this.#readIssues().finally(() => {
      this.#issuesInFlight = undefined;
    });

    return this.#issuesInFlight;
  }

  /**
   * `again` is for a change the read in flight cannot have seen: a session that ended after that read listed it
   * would otherwise sit on the board until the next poll. A timer or a button coalesces, being a read of now.
   */
  #refreshSessions(again = false): Promise<void> {
    if (this.#sessionsInFlight) {
      return again ? this.#sessionsInFlight.then(() => this.#refreshSessions()) : this.#sessionsInFlight;
    }

    this.#sessionsInFlight = this.#readSessions().finally(() => {
      this.#sessionsInFlight = undefined;
    });

    return this.#sessionsInFlight;
  }

  async #readIssues(): Promise<void> {
    const source = readGithubConfig(this.#config.sources['github']);

    if ('failure' in source) {
      this.#issuesError = source.failure;
      this.#broadcast();

      return;
    }

    const config = source.config;

    // Nobody to read for. The hub cannot ask — it has no screen — so it says what it needs and what it could
    // detect, and a client puts the question to the developer (R26, R28).
    if (config.logins.length === 0) {
      this.#needsLogins = { detected: await this.#deps.detectLogins(config.ghPath) };
      this.#issuesError = {
        subject: 'issues',
        kind: 'no-logins',
        message: 'The board does not know which GitHub account is yours, so it is showing sessions only.',
        remedy: 'Set groundControl.github.logins in Settings, or run Ground Control: Refresh Board to be asked again.',
      };
      this.#broadcast();

      return;
    }

    this.#needsLogins = null;
    this.#logins = config.logins;

    const result = await this.#deps.readIssues(config);

    if (this.#disposed) {
      return;
    }

    if (result.ok) {
      this.#issues = result.value;
      this.#issuesError = undefined;
    } else {
      this.#issuesError = { ...result.error, subject: 'issues' };
    }

    this.#broadcast();
  }

  async #readSessions(): Promise<void> {
    const readers = this.#readers();

    // Off the click path on purpose: what an open needs costs the best part of a second cold and almost nothing
    // once read, and none of it changes on the developer's click.
    for (const host of this.#deps.registries.hosts) {
      host.prime(readers);
    }

    const snapshot = await fetchSessions(
      { agents: this.#config.agents, branchIssuePattern: this.#config.branchIssuePattern },
      this.#deps.registries.agents,
      readers,
    );

    if (this.#disposed) {
      return;
    }

    // Always a snapshot: one CLI being unreadable contributes a failure and no sessions, and must not discard the
    // rest. The activity is re-read as it lands, because a poll that began before an event carries the older phase.
    this.#sessions = { ...snapshot, sessions: snapshot.sessions.map((session) => this.#withActivity(session)) };
    this.#sessionsUnreadable = snapshot.sessions.length === 0 && snapshot.failures.length > 0;

    this.#broadcast();
  }

  #readers(): MachineReaders {
    return diskReaders(this.#deps.home);
  }

  // — the activity signal —

  /**
   * An event on the signal. A session that ended, or one the hub has never listed, moved the list itself and only
   * the CLI can report it; anything else is a phase on a session already up, which is a file read rather than a spawn.
   */
  #onActivity(changes: readonly ActivityChange[]): void {
    // Watched, not merely alive: a board that is closed pays the same CLI spawn for an event as one on screen, and
    // there is nobody to show the result to (R35).
    if (this.#disposed || !this.#watched()) {
      return;
    }

    const known = new Set(this.#sessions?.sessions.map((session) => session.sessionId) ?? []);
    const stale = rosterIsStale(changes, known, (id) => this.#phaseOf(id) !== null);

    // Not while the CLI is unreadable: it lists nothing, so every batch would be stale and spawn a read that fails
    // again. The timer keeps retrying, which is the one place a read that may fail belongs.
    if (stale && !this.#sessionsUnreadable) {
      void this.#refreshSessions(true);

      return;
    }

    if (this.#sessions === undefined) {
      return;
    }

    this.#sessions = {
      ...this.#sessions,
      sessions: this.#sessions.sessions.map((session) => this.#withActivity(session)),
    };

    this.#broadcast();
  }

  #phaseOf(sessionId: string) {
    for (const agent of this.#deps.registries.agents) {
      const reported = agent.activity?.read(this.#deps.home, sessionId, read) ?? null;

      if (reported !== null) {
        return reported;
      }
    }

    return null;
  }

  #withActivity(session: Session): Session {
    const agent = this.#deps.registries.agents.find((a) => a.id === session.agent);

    return { ...session, activity: agent?.activity?.read(this.#deps.home, session.sessionId, read) ?? null };
  }

  // — the developer's own acts —

  #move(key: string, lane: LaneId): void {
    this.#deps.lanes.write(withPlacement(this.#memory(), key, lane));
    this.#broadcast();
  }

  /**
   * Where a session can be reached, and by whom. Every route the VS Code host plans is one only a client inside that
   * application can perform, so the plan goes back to the client that asked for it rather than being carried out here.
   */
  async #open(client: Connected, sessionId: string, extensionReady: boolean): Promise<void> {
    const host = this.#deps.registries.hosts.find((h) => h.id === client.hello.hostId);

    if (host === undefined) {
      client.send({
        type: 'notice',
        level: 'warning',
        message: 'This board is not running inside an application that can open a session.',
      });

      return;
    }

    const sessions = this.#sessions?.sessions ?? [];
    const readers = this.#readers();
    const [windows, surfaces] = await Promise.all([
      host.windows(
        sessions.find((session) => session.sessionId === sessionId),
        readers,
      ),
      host.surfaces(readers),
    ]);

    const plan = host.plan({
      sessionId,
      sessions,
      surfaces,
      window: windows.holding,
      liveRoots: windows.live.flatMap((window) => window.folders),
      workspaceRoot: client.hello.workspaceRoot,
      extensionReady,
      now: this.#deps.clock.now(),
    });

    if ('refusal' in plan) {
      client.send({ type: 'notice', level: 'warning', message: plan.message, refusal: plan.refusal });

      return;
    }

    if (host.residentRoutes.includes(plan.route)) {
      client.send({ type: 'perform', route: plan });

      return;
    }

    await host.open?.(plan, readers);
  }

  // — the snapshot —

  #memory() {
    return this.#deps.lanes.read(this.#config.boardStatuses);
  }

  /**
   * One snapshot carries the whole board. A source that failed keeps its last good read in it and contributes a
   * failure instead of an empty list — R24 forbids implying a read succeeded, and equally forbids erasing a board
   * the developer can still read.
   */
  snapshot(): Snapshot {
    const activity = this.#ensureActivity();
    const failures: ReadFailure[] = [...this.#configFailures];

    if (activity?.failure) {
      failures.push(activity.failure);
    }

    if (this.#issuesError) {
      failures.push(this.#issuesError);
    }

    for (const failure of this.#sessions?.failures ?? []) {
      failures.push({ ...failure, subject: 'sessions' });
    }

    const memory = this.#memory();
    const lanes = assignLanes(
      mergeBoard(this.#issues?.cards ?? [], this.#sessions?.sessions ?? []),
      {
        boardStatuses: this.#config.boardStatuses,
        statusLanes: this.#config.statusLanes,
        logins: this.#logins,
      },
      memory,
    );

    return {
      lanes,
      issues: this.#issues
        ? {
            count: this.#issues.cards.length,
            matched: this.#issues.matched,
            totalAssigned: this.#issues.totalAssigned,
            notOnProject: this.#issues.notOnProject,
            truncated: this.#issues.truncated,
            fetchedAt: this.#issues.fetchedAt,
          }
        : null,
      sessions: this.#sessions
        ? {
            count: this.#sessions.sessions.length,
            patternError: this.#sessions.patternError,
            fetchedAt: this.#sessions.fetchedAt,
          }
        : null,
      // Filled in per client: what a board may open is the answer of the host it is running inside (R14).
      openable: [],
      hooks: null,
      failures,
      stale: this.#issuesError !== undefined || (this.#sessions?.failures.length ?? 0) > 0,
      needs: this.#needsLogins === null ? null : { logins: this.#needsLogins },
      fetchedAt: new Date(this.#deps.clock.now()).toISOString(),
    };
  }

  /**
   * Writes back what a snapshot settled: where each card now sits, and what the install stamp now is. Separate from
   * `snapshot`, which any caller may ask for — a read that rewrites the developer's lane placements under whatever
   * configuration the hub happens to hold is a read nobody can make safely.
   */
  #persist(lanes: Lane[]): void {
    const memory = this.#memory();

    // Only a clean session read proves a session is gone; a failed one reports none, and would discard its placement.
    const sessionsRead = this.#sessions !== undefined && this.#sessions.failures.length === 0;

    this.#deps.lanes.write(nextMemory(lanes, memory, sessionsRead));

    const activity = this.#activity;

    if (activity === null) {
      return;
    }

    const next = afterInstall(this.#deps.marks.read(), activity.wanted, activity.added, this.#deps.clock.now());

    this.#deps.marks.write(next);
    this.#installedAt = next.installedAt ?? 0;
  }

  /**
   * What this client has not already been told. Installing the signal is something that happened, not a condition,
   * so it is said once per board — a second window has not read the first one's notice (R25).
   */
  #noticeFor(id: string): { notice: string } | null {
    if (this.#activity === null) {
      return null;
    }

    const notice = activityNotice({
      plan: this.#activity.plan,
      wanted: this.#activity.wanted,
      unreported: unreportedSessions(this.#sessions?.sessions ?? [], this.#installedAt),
    });

    if (notice === null) {
      return null;
    }

    const { say, next } = announce(this.#deps.marks.read(), id);

    if (!say) {
      return null;
    }

    this.#deps.marks.write(next);

    return { notice };
  }

  /**
   * One snapshot, finished per client. What a board may open is its own host's answer, and a notice is said once per
   * board — a second window has not read the first one's (R14, R25).
   */
  #sendTo(id: string, type: 'snapshot' | 'changed', base = this.snapshot()): void {
    const client = this.#clients.get(id);

    if (client === undefined) {
      return;
    }

    const host = this.#deps.registries.hosts.find((h) => h.id === client.hello.hostId);

    client.send({
      type,
      snapshot: {
        ...base,
        openable: host?.openable(this.#sessions?.sessions ?? []) ?? [],
        hooks: this.#noticeFor(id),
      },
    } as HubMessage);
  }

  #broadcast(): void {
    if (this.#disposed) {
      return;
    }

    const base = this.snapshot();

    this.#persist(base.lanes);

    for (const id of [...this.#clients.keys()]) {
      this.#sendTo(id, 'changed', base);
    }
  }

  dispose(): void {
    this.#disposed = true;

    while (this.#timers.length > 0) {
      this.#deps.clock.clearInterval(this.#timers.pop()!);
    }

    while (this.#watchers.length > 0) {
      this.#watchers.pop()?.dispose();
    }

    this.#clients.clear();
  }
}
