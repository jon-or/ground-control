import { assignLanes, mergeBoard, nextMemory, withPlacement, withTriage } from '@ground-control/board';
import { compilePattern, diskReaders, fetchSessions, fetchSessionHistory, parseHubConfig, rosterIsStale, unreportedSessions } from '@ground-control/core';
import type { ActivityChange, Client, ClientHello, ClientMessage, HistoricalSession, HostAdapter, HubConfig, HubMessage, Lane, LaneId, Logger, MachineReaders, ReadFailure, Session, SessionsSnapshot, Snapshot, SourceReading, WorkItems, WorkSource } from '@ground-control/core';
import { activityAcknowledgement, activityNotice, pruneMarkers, syncActivity } from './activityInstall.js';
import type { ActivityState } from './activityInstall.js';
import { read } from './fs.js';
import type { LaneStore } from './lanes.js';
import { ActionRunner } from './actions.js';
import { makeActionStore } from './actionStore.js';
import type { ActionStore } from './actionStore.js';
import { TriageRunner } from './triage.js';
import { makeTriageStore } from './triageStore.js';
import type { TriageStore } from './triageStore.js';
import { afterInstall, announce } from './marks.js';
import type { MarkStore } from './marks.js';
import type { SettingsStore } from './settings.js';
import { configureHosts, configureSources, defaultConfig } from './registry.js';
import type { Registries } from './registry.js';
import { readLogTail } from './logger.js';
import { logPathOf } from './paths.js';

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
  /** What the board has read about each card, kept beside the placements and read the same way (R38). */
  triage: TriageStore;
  /** What the board has run on each card, kept the same way again (R39). */
  actions: ActionStore;
  /** The configuration a client last pushed. A hub starts on it, because the browser has none of its own to give. */
  settings: SettingsStore;
  /** What the hub says about itself. Written to `hub.log` whatever happens; streamed only to a client that asked. */
  log: Logger;
  /** The activity install, which is also the thing a test replaces to keep its hands off any settings file. */
  syncActivity(registries: Registries, wanted: 'install' | 'remove', home: string, enabled?: ReadonlySet<string>): ActivityState;
}

interface Connected {
  hello: ClientHello;
  send(message: HubMessage): void;
  watching: boolean;
  /** Undoes this client's log subscription. Null while no viewer of theirs is open, which is where every one starts. */
  unwatchLog: (() => void) | null;
}

/** One source that cannot be reached, held rather than reported until `OUTAGE_GRACE_MS` says otherwise. */
interface Outage {
  since: number;
  retryAt: number;
  announced: boolean;
}

/** A refresh asked for again inside this is the same read. The button, not the timers, is what this is for. */
const REFRESH_FLOOR_MS = 1000;

/** Why a read was called for, which is the floor it is answered against. */
type Reason = 'visible' | 'asked' | 'settings';

/**
 * How stale a source reading may be before a board becoming visible is worth a network round trip. Without it a
 * developer moving between a board and their code reads GitHub once a second, which GitHub rate limits (R35).
 */
const SOURCE_FLOOR_MS = 60_000;

/**
 * How long a source may be unreachable before the board says so. Under it the board holds the read it already has:
 * a machine coming back from sleep fails one read and succeeds the next, and that is not a condition to act on (R25).
 */
const OUTAGE_GRACE_MS = 60_000;

/**
 * What an unreachable source waits before the next try, taken from how long it has been unreachable rather than from
 * how many tries it has cost: a developer pressing refresh during an outage must not spend the ladder and leave the
 * board recovering later than if they had left it alone.
 */
function backoffMs(outageMs: number): number {
  return outageMs < 30_000 ? 5_000 : outageMs < 120_000 ? 15_000 : outageMs < 600_000 ? 60_000 : 120_000;
}

/** The cadence the outage retry and the suspend check share. Neither costs anything on the passes that find nothing. */
const TICK_MS = 5_000;

/**
 * A tick this much later than it was due is a machine that was suspended, not a loop that ran slow: the poll timers
 * counted none of the sleep, so without this a laptop opened after an hour reads nothing for another five minutes.
 */
const WAKE_GAP_MS = 20_000;

/**
 * Two settings that would be read with identically. Key order is not a difference: a source's entry is its own
 * shape, which `core` deliberately does not know, and a client may build it in any order it likes.
 */
function same(before: unknown, after: unknown): boolean {
  return canonical(before) === canonical(after);
}

/** Every configuration arrives as JSON — over the loopback, over native messaging, or parsed from `config.json`. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, held]) => `${JSON.stringify(key)}:${canonical(held)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

const REAL_CLOCK: HubClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
};

export function realHubDeps(
  registries: Registries,
  lanes: LaneStore,
  marks: MarkStore,
  settings: SettingsStore,
  home: string,
  watch: HubDeps['watch'],
  log: Logger,
  triage: TriageStore = makeTriageStore(home),
  actions: ActionStore = makeActionStore(home),
): HubDeps {
  return {
    clock: REAL_CLOCK,
    watch,
    home,
    registries,
    lanes,
    marks,
    triage,
    actions,
    settings,
    log,
    syncActivity: (regs, wanted, where, enabled) => syncActivity(regs.agents, wanted, where, false, enabled),
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
  /** The source settings this configuration refused. A board with no source it can read is a board that is stale. */
  #sourcesRefused: ReadFailure[] = [];

  /** Each source keeps its last good read and its last failure, so one failing never blanks the other (R24). */
  readonly #readings = new Map<string, SourceReading>();
  /** Sources that cannot be reached: when each went, how many tries it has cost, and whether the board has said so. */
  readonly #outages = new Map<string, Outage>();
  #lastTickAt = 0;
  #sessions: SessionsSnapshot | undefined;
  #history: HistoricalSession[] = [];
  #historyFailures: ReadFailure[] = [];
  readonly #resuming = new Map<string, number>();
  #sourcesInFlight: Promise<void> | undefined;
  #sessionsInFlight: Promise<void> | undefined;
  #lastReadAt = 0;
  #lastSourceReadAt = 0;
  /** The last read listed nothing and every agent failed, so an activity event has nothing to re-read. */
  #sessionsUnreadable = false;
  /** Which agents the log last said were unreadable, by subject and kind. Never by message — see `#sayAboutSessions`. */
  #saidAboutSessions = '';
  /** Null until a client has said whether it wants the signal at all. Nothing is written to an agent before that. */
  #activity: ActivityState | null = null;
  #configured = false;
  /** A stored configuration this hub would not run on. Shown until a client pushes one, which is what replaces it. */
  #stored: ReadFailure | null = null;
  #installedAt = 0;
  #disposed = false;
  readonly #triage: TriageRunner;
  readonly #actions: ActionRunner;

  constructor(deps: HubDeps) {
    this.#deps = deps;

    // What a client last pushed, where there is one. Which repository work is tracked in cannot be guessed, so a
    // hub started by the browser alone would otherwise be permanently unconfigured however long ago the developer
    // set it — and the settings live in an editor that need not be open (R35, R36).
    const stored = deps.settings.read();

    this.#config = stored && 'config' in stored ? stored.config : defaultConfig(deps.registries);
    this.#stored = stored && 'failure' in stored ? stored.failure : null;
    // Applied here rather than as each client turns up: a second window connecting would otherwise overwrite what
    // the board is saying about the first one's settings, while the hub is still running on the older ones.
    this.#configFailures = this.#applyConfig();
    this.#triage = new TriageRunner({
      home: deps.home,
      store: deps.triage,
      log: deps.log,
      agents: deps.registries.agents,
      sources: deps.registries.sources,
      now: () => deps.clock.now(),
      changed: () => this.#broadcast(),
      announce: (message) => this.#tellOnceAboutTriage(message),
    });
    this.#triage.configure(this.#config.triage, this.#config.agents, this.#config.statusLanes);
    this.#actions = new ActionRunner({
      home: deps.home,
      store: deps.actions,
      log: deps.log,
      agents: deps.registries.agents,
      sources: deps.registries.sources,
      now: () => deps.clock.now(),
      changed: () => this.#broadcast(),
      announce: (message) => this.#tellOnceAboutActions(message),
      // Every client, because the runner does not know which one pressed and a board the developer is not looking at
      // is a board that says nothing. One notice per refusal, which is what R25 asks of a condition stated once.
      notify: (message) => {
        for (const client of this.#clients.values()) {
          client.send({ type: 'notice', level: 'info', message });
        }
      },
    });
    this.#actions.configure(this.#config.actions, this.#config.agents);
    pruneMarkers(deps.registries.agents, deps.home);
    this.#armWatchers();
  }

  // — clients —

  connect(hello: ClientHello, send: (message: HubMessage) => void): Client {
    this.#clients.set(hello.id, { hello, send, watching: hello.watching, unwatchLog: null });

    this.#deps.log.info(
      `${hello.id} connected from ${hello.hostId ?? 'no host'}, ${hello.watching ? 'watching' : 'not watching'}`,
      'clients',
    );
    this.#sendTo(hello.id, 'snapshot');
    this.#retime();

    return { id: hello.id };
  }

  disconnect(client: Client): void {
    this.#clients.get(client.id)?.unwatchLog?.();
    this.#clients.delete(client.id);
    this.#deps.log.info(`${client.id} went away, leaving ${this.#clients.size}`, 'clients');
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
        this.#deps.log.debug(`${client.id} said hello again, ${message.hello.watching ? 'watching' : 'not watching'}`, 'clients');
        this.#retime();

        return;

      case 'configure': {
        const resynced = this.configure(message.config);

        // Only where a developer changed the setting themselves. Every client pushes its configuration on connect,
        // and a hub that answered each of those would pop a message on every board that opened (R34).
        if (!message.acknowledge) {
          return;
        }

        // A refusal returns nothing to acknowledge, and is the one answer the developer most needs: the change they
        // just made did not happen, and the board it is named on may not be open (R34).
        connected.send(
          resynced
            ? { type: 'notice', ...activityAcknowledgement(resynced) }
            : { type: 'notice', level: 'error', message: this.#configFailures[0]?.message ?? 'The board could not read those settings.' },
        );

        return;
      }

      case 'watching':
        connected.watching = message.watching;
        this.#retime();

        // A board coming back shows what is already known before the read it triggers lands.
        if (message.watching) {
          this.#sendTo(client.id, 'snapshot');
          void this.refresh();
        }

        return;

      case 'watchLog':
        this.#watchLog(connected, message.watching);

        return;

      case 'refresh':
        void this.refresh('asked');

        return;

      case 'move':
        this.#move(message.key, message.lane);

        return;

      case 'open':
        void this.#open(connected, message.sessionId, message.extensionReady, message.handedOver === true);

        return;

      case 'retriage': {
        // The one message that spends money, so the key has to name a card on the board and the ask is rationed.
        const refused = this.#triage.retriage(this.snapshot().lanes, message.key);

        if (refused) {
          connected.send({ type: 'notice', level: 'info', message: refused.message });
        }

        return;
      }

      case 'runAction': {
        // The message that changes the developer's code. Every gate an automatic dispatch runs is run for this one
        // too, against a fresh read — what the click replaces is the setting, never a safety check.
        const refused = this.#actions.runAction(this.snapshot().lanes, message.key);

        if (refused) {
          connected.send({ type: 'notice', level: 'info', message: refused.message });
        }

        return;
      }

      case 'stopAction':
        void this.#actions.stopAction(message.key).then((refused) => {
          if (refused) {
            connected.send({ type: 'notice', level: 'warning', message: refused.message });
          }
        });

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
      this.#deps.log.warn(`a client's settings were refused: ${parsed.failure.message}`, 'config');
      this.#broadcast();

      return null;
    }

    const before = this.#config;

    this.#config = parsed.config;

    if (same(before, parsed.config)) {
      this.#deps.log.debug('settings restated unchanged', 'config');
    } else {
      // Written before `#applyConfig` moves the floor, so turning the log down still says why it went quiet.
      this.#deps.log.info(`settings changed by a client; the log level is now ${parsed.config.logLevel}`, 'config');
    }

    const sessionsChanged = !same(before.agents, parsed.config.agents) || before.branchIssuePattern !== parsed.config.branchIssuePattern;
    if (sessionsChanged) {
      this.#sessions = undefined;
      this.#history = [];
      this.#historyFailures = [];
    }
    this.#configFailures = this.#applyConfig();
    this.#stored = null;

    // Only a configuration nothing objected to. A host or a source refuses one the schema cannot — an unknown id,
    // a repository with no owner — and remembering that would carry the mistake past the window that made it, to a
    // hub the browser starts with no editor open to correct it.
    if (this.#configFailures.length === 0) {
      this.#deps.settings.write(parsed.config);
    }

    const first = !this.#configured;
    this.#configured = true;

    // The first configuration is what says whether the developer wants the signal at all, so the install waits for
    // it: putting entries in an agent's settings on the hub's own default would write for a developer who turned
    // them off, and then take them away again (R34).
    // Forced, not lazy: `#ensureActivity` keeps a settled run, and a setting that changed is exactly the case
    // where the settled run is the wrong one (R34).
    // A named agent that was not named before has no signal in place yet, so the install runs for it too.
    const agents = (config: HubConfig): string => config.agents.map((agent) => agent.id).sort().join(',');
    const changed =
      first ||
      before.installActivity !== parsed.config.installActivity ||
      agents(before) !== agents(parsed.config);
    const resynced = changed ? this.#installActivity() : this.#ensureActivity();

    if (changed) {
      this.#armWatchers();
    }

    if (
      before.refreshIntervalMs !== parsed.config.refreshIntervalMs ||
      before.sessionIntervalMs !== parsed.config.sessionIntervalMs
    ) {
      this.#retime(true);
    }

    // Said before the read rather than left to it: the read has a floor, so a setting corrected within a second of
    // being made wrong would leave every board showing the complaint until the next poll.
    this.#broadcast();
    // Read now only where the settings a source reads with moved, so the cards on screen answer to them. Every
    // client restates its configuration on connect, and reading for each of those is a read per board that opens.
    const reason = same(before.sources, parsed.config.sources) ? 'visible' : 'settings';
    if (sessionsChanged) {
      void this.#refreshSources(reason);
      void this.#refreshSessions(true);
    } else {
      void this.refresh(reason);
    }

    return resynced;
  }

  /** Hands each host and each source its own entry. Every id the registries do not carry is named here (R25). */
  #applyConfig(): ReadFailure[] {
    this.#deps.log.setLevel(this.#config.logLevel);
    this.#triage?.configure(this.#config.triage, this.#config.agents, this.#config.statusLanes);
    this.#actions?.configure(this.#config.actions, this.#config.agents);

    const refused = configureSources(this.#deps.registries, this.#config.sources);

    // A source this configuration does not name, and one whose settings it refused, both lose their last read here
    // rather than at the next poll: with nothing watching there may not be one, and cards read for settings nobody
    // is naming any more would sit on the board for as long as five minutes.
    for (const id of [...this.#readings.keys()]) {
      if (!Object.hasOwn(this.#config.sources, id) || refused.some((failure) => failure.subject === id)) {
        this.#readings.delete(id);
        // Its outage with it: nothing reads that source again, so the retry it is waiting on would never come due,
        // and the tick would spend a read on every surviving source every five seconds for the life of the hub.
        this.#outages.delete(id);
      }
    }

    this.#sourcesRefused = refused;

    return [...configureHosts(this.#deps.registries, this.#config.hosts), ...refused];
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
    // An install reaches only the agents the configuration names, so the board never writes into the settings of a
    // CLI it was not asked to read (R30). A removal reaches every one of them: it is the developer turning the hooks
    // off, and leaving another agent's entries behind would leave a writer nobody maintains firing (R34).
    this.#activity = this.#config.installActivity
      ? this.#deps.syncActivity(
          this.#deps.registries,
          'install',
          this.#deps.home,
          new Set(this.#config.agents.map((agent) => agent.id)),
        )
      : this.#deps.syncActivity(this.#deps.registries, 'remove', this.#deps.home);

    return this.#activity;
  }

  // — polling —

  /**
   * A viewer opening or closing. Opening reads the tail of `hub.log` and subscribes to what comes after it;
   * closing undoes both. Nothing is held for a client that has not asked — no buffer against the chance somebody
   * looks, and no reason to touch the file. The backfill comes off disk rather than out of memory, which is what
   * lets a viewer opened after a restart carry the last hub's dying words as well as this one's.
   *
   * It never makes this client watched: a developer reading the log is not a board on screen, and turning the
   * poll loop on for one would spend a CLI spawn every thirty seconds for a window nobody is looking at (R35).
   */
  #watchLog(client: Connected, watching: boolean): void {
    client.unwatchLog?.();
    client.unwatchLog = null;

    if (!watching) {
      this.#deps.log.debug(`${client.hello.id} closed its log viewer`, 'clients');

      return;
    }

    const backfill = readLogTail(this.#readers().readTail, logPathOf(this.#deps.home));

    if (backfill.length > 0) {
      client.send({ type: 'log', entries: backfill });
    }

    // Installed before the line saying so, which is therefore the first live entry the viewer receives.
    client.unwatchLog = this.#deps.log.watch((entry) => client.send({ type: 'log', entries: [entry] }));
    this.#deps.log.debug(`${client.hello.id} opened its log viewer`, 'clients');
  }

  #watched(): boolean {
    return [...this.#clients.values()].some((client) => client.watching);
  }

  /**
   * Timers exist only while something is watching. Left alone when nothing about them changed: a client that says
   * what it already said — a browser worker Chrome restarted, a second board — would otherwise restart the clock
   * the periodic read is counting on.
   */
  #retime(cadenceChanged = false): void {
    const wanted = !this.#disposed && this.#watched();

    if (wanted === (this.#timers.length > 0) && !cadenceChanged) {
      return;
    }

    while (this.#timers.length > 0) {
      this.#deps.clock.clearInterval(this.#timers.pop()!);
    }

    if (!wanted) {
      this.#deps.log.debug('nothing is watching, so the timers are down', 'loop');

      return;
    }

    this.#deps.log.debug(
      `polling sources every ${this.#config.refreshIntervalMs}ms and sessions every ${this.#config.sessionIntervalMs}ms`,
      'loop',
    );
    this.#lastTickAt = this.#deps.clock.now();
    this.#timers.push(
      this.#deps.clock.setInterval(() => void this.#refreshSources('asked'), this.#config.refreshIntervalMs),
      this.#deps.clock.setInterval(() => void this.#refreshSessions(), this.#config.sessionIntervalMs),
      this.#deps.clock.setInterval(() => this.#tick(), TICK_MS),
    );
  }

  /**
   * The two things the poll cadences cannot answer for: a machine that was asleep between two of them, and a network
   * that was not back yet when one of them ran.
   */
  #tick(): void {
    const now = this.#deps.clock.now();
    const gap = now - this.#lastTickAt;
    const slept = gap > TICK_MS + WAKE_GAP_MS;

    this.#lastTickAt = now;

    if (slept) {
      this.#deps.log.info(`the machine was away about ${Math.round(gap / 1000)}s; reading everything again`, 'loop');
      // The sleep is not part of the outage: a source that failed on the way down gets its minute over again, and
      // its next try is now. One the board has already stated stays stated — `#riding` keys on that rather than on
      // the clock, because a stall long enough to look like a suspend must not retract a notice that still holds.
      for (const outage of this.#outages.values()) {
        outage.since = now;
        outage.retryAt = now;
      }

      void this.#refreshSources('asked');
      void this.#refreshSessions();

      return;
    }

    // Announced here rather than on the try that finds the source still down: that try may be two minutes out, and
    // one that hangs never answers at all — which would leave a dimmed board saying nothing for as long as it hung.
    const overdue = [...this.#outages.values()].filter(
      (outage) => !outage.announced && now - outage.since >= OUTAGE_GRACE_MS,
    );

    for (const outage of overdue) {
      outage.announced = true;
    }

    if (overdue.length > 0) {
      this.#deps.log.warn(`${overdue.length} source(s) unreachable for over a minute; saying so on the board`, 'sources');
      this.#broadcast();
    }

    if ([...this.#outages.values()].some((outage) => outage.retryAt <= now)) {
      void this.#refreshSources('asked');
    }
  }

  /**
   * One watcher per configured agent that offers a signal. Only the configured ones: an agent the board was not
   * asked to read has no activity directory, and a watcher on a directory nothing creates retries once a second for
   * the life of the hub. Re-armed when the configuration names a different set.
   */
  #armWatchers(): void {
    while (this.#watchers.length > 0) {
      this.#watchers.pop()?.dispose();
    }

    const named = new Set(this.#config.agents.map((agent) => agent.id));

    for (const agent of this.#deps.registries.agents) {
      if (agent.activity && named.has(agent.id)) {
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
  async roster(): Promise<readonly Session[] | null> {
    await this.#refreshSessions(true);

    return this.#sessions && this.#sessions.failures.length === 0 ? this.#sessions.sessions : null;
  }

  /** Reads both sources, each on the floor its own cost earns. */
  refresh(reason: Reason = 'visible'): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve();
    }

    const now = this.#deps.clock.now();
    const reads = [this.#refreshSources(reason)];

    // The session read spawns a CLI, so it keeps a floor of its own: a button pressed twice in a second is one
    // roster read rather than two processes (mechanics §2).
    if (now - this.#lastReadAt >= REFRESH_FLOOR_MS) {
      this.#lastReadAt = now;
      reads.push(this.#refreshSessions());
    }

    return Promise.all(reads).then(() => undefined);
  }

  /**
   * A source read is a network round trip, so a board that merely became visible gets the reading already taken
   * unless it has gone stale. A read asked for waits only out the second that makes two asks one read, and settings
   * that moved wait out nothing: the read in flight was issued with the ones they replaced, so one follows it.
   */
  #refreshSources(reason: Reason = 'visible'): Promise<void> {
    if (this.#sourcesInFlight) {
      return reason === 'settings' ? this.#sourcesInFlight.then(() => this.#refreshSources(reason)) : this.#sourcesInFlight;
    }

    const now = this.#deps.clock.now();

    if (reason !== 'settings' && now - this.#lastSourceReadAt < (reason === 'asked' ? REFRESH_FLOOR_MS : SOURCE_FLOOR_MS)) {
      return Promise.resolve();
    }

    this.#lastSourceReadAt = now;
    this.#sourcesInFlight = this.#readSources().finally(() => {
      this.#sourcesInFlight = undefined;
    });

    return this.#sourcesInFlight;
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

  /** Every source the configuration names, read together. A source it does not name costs no read at all. */
  async #readSources(): Promise<void> {
    const sources = this.#deps.registries.sources.filter((source) =>
      Object.hasOwn(this.#config.sources, source.id),
    );

    await Promise.all(sources.map((source) => this.#readSource(source)));

    if (this.#disposed) {
      return;
    }

    this.#broadcast();
  }

  async #readSource(source: WorkSource): Promise<void> {
    const startedAt = this.#deps.clock.now();
    const reading = await source.read().catch(
      (error: unknown): SourceReading => ({
        items: null,
        // A source is a seam anyone may implement, and one that throws must land on the board like one that failed
        // — swallowed, it takes every other source's broadcast with it and says nothing anywhere the developer looks.
        failure: {
          subject: source.id,
          kind: 'source-failed',
          message: `${source.displayName} could not be read: ${String(error)}`,
          remedy: 'Refresh the board. If it keeps happening, the hub log carries what it threw.',
        },
        needs: null,
      }),
    );

    const held = this.#readings.get(source.id);
    const now = this.#deps.clock.now();

    if (reading.failure?.transient === true) {
      const outage = this.#outages.get(source.id);
      const since = outage?.since ?? now;

      this.#outages.set(source.id, {
        since,
        retryAt: now + backoffMs(now - since),
        announced: outage?.announced ?? false,
      });
    } else {
      this.#outages.delete(source.id);
    }

    // A failed read keeps what the source last returned, and says what went wrong beside it (R24). A source with
    // nothing to say at all had its settings refused, and its cards go with them: they were read for a repository
    // the developer is no longer asking about, under a board that already says the settings were refused.
    const items = reading.items ?? (reading.failure ? held?.items ?? null : null);

    this.#readings.set(source.id, { ...reading, items });

    const took = now - startedAt;

    if (reading.failure) {
      this.#deps.log.warn(`${source.id} could not be read after ${took}ms: ${reading.failure.kind}`, 'sources');
    } else if (reading.items === null) {
      this.#deps.log.debug(`${source.id} has no settings to read with`, 'sources');
    } else {
      this.#deps.log.info(`${source.id} read ${reading.items.cards.length} cards in ${took}ms`, 'sources');
    }
  }

  /** What every source last read, as one board. A source that has read nothing contributes nothing, not an absence. */
  #items(): WorkItems | null {
    const read = [...this.#readings.values()].flatMap((reading) => reading.items ?? []);

    if (read.length === 0) {
      return null;
    }

    return {
      cards: read.flatMap((items) => items.cards),
      owners: read.flatMap((items) => items.owners),
      matched: read.reduce((total, items) => total + items.matched, 0),
      totalAssigned: read.reduce((total, items) => total + items.totalAssigned, 0),
      notOnProject: read.reduce((total, items) => total + items.notOnProject, 0),
      truncated: read.some((items) => items.truncated),
      // The oldest of them: the board is only as fresh as the source that has not been read since.
      fetchedAt: read.map((items) => items.fetchedAt).sort()[0]!,
    };
  }

  async #readSessions(): Promise<void> {
    const readers = this.#readers();
    const config = { agents: this.#config.agents, branchIssuePattern: this.#config.branchIssuePattern };
    const current = () => !this.#disposed && same(config, { agents: this.#config.agents, branchIssuePattern: this.#config.branchIssuePattern });

    // Off the click path on purpose: what an open needs costs the best part of a second cold and almost nothing
    // once read, and none of it changes on the developer's click.
    for (const host of this.#deps.registries.hosts) {
      host.prime(readers);
    }

    const startedAt = this.#deps.clock.now();

    let snapshot = await fetchSessions(
      config,
      this.#deps.registries.agents,
      readers,
    );

    if (!current()) {
      return;
    }

    // Always a snapshot: one CLI being unreadable contributes a failure and no sessions, and must not discard the
    // rest. The activity is re-read as it lands, because a poll that began before an event carries the older phase.
    // The board's own classifications, taken off before anything downstream counts or merges them. The adapter
    // already drops them — a classification is listed in exactly the shape `neverPrompted` refuses — so this is what
    // still holds if a flag ever stops doing what it says (R2's carve-out, `docs/mechanics.md` §31).
    const ours = this.#triage.sessionIds();

    if (ours.size > 0) {
      snapshot = { ...snapshot, sessions: snapshot.sessions.filter((session) => !ours.has(session.sessionId)) };
    }

    const liveIds = new Set(snapshot.sessions.filter((s) => !s.finished).map((s) => `${s.agent}:${s.sessionId}`));
    const endedIssues = new Set(this.#sessions?.sessions.filter((s) => !s.finished && !liveIds.has(`${s.agent}:${s.sessionId}`)).map((s) => s.issueNumber));
    this.#sessions = { ...snapshot, sessions: snapshot.sessions.map((session) => this.#withActivity(session)) };
    this.#sessionsUnreadable = snapshot.sessions.length === 0 && snapshot.failures.length > 0;
    this.#sayAboutSessions(snapshot.failures, snapshot.sessions.length, this.#deps.clock.now() - startedAt);
    // Stable cards keep their rows while history refreshes. A just-ended attempt needs a fresh history read,
    // otherwise the older attempt would briefly appear in its place.
    this.#history = snapshot.failures.length > 0 ? [] : this.#history.filter((s) => !endedIssues.has(s.issueNumber));
    this.#historyFailures = [];

    // Publish live rows even if history is slow or fails. An incomplete roster cannot establish inactivity.
    this.#broadcast();
    if (snapshot.failures.length > 0) return;
    const history = await fetchSessionHistory(config, this.#deps.registries.agents, readers);
    if (!current()) return;
    this.#history = history.sessions;
    this.#historyFailures = history.failures;

    this.#broadcast();
  }

  /**
   * One line per session read at `debug`, because the cadence is every thirty seconds and a line each at `info`
   * would outwrite the log in a day. A failure is a `warn`, and only where the set of them has moved: an agent
   * whose CLI is missing fails every read, and repeating that twice a minute buries everything else in the file.
   */
  #sayAboutSessions(failures: readonly ReadFailure[], listed: number, took: number): void {
    this.#deps.log.debug(`${listed} sessions in ${took}ms`, 'sessions');

    // Keyed on subject and kind, never on the message: an agent adapter puts its CLI's own output in one, so a
    // failure whose text moves between attempts would write a line every read — which is the flood this prevents.
    const key = failures.map((failure) => `${failure.subject}/${failure.kind}`).join(' ');

    if (key === this.#saidAboutSessions) {
      return;
    }

    this.#saidAboutSessions = key;

    // An empty set that was not empty before is a CLI that has come back, which is worth as much as its going.
    if (key === '') {
      this.#deps.log.info('every agent is readable again', 'sessions');

      return;
    }

    this.#deps.log.warn(failures.map((failure) => `${failure.subject}: ${failure.message}`).join('; '), 'sessions');
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

    this.#deps.log.debug(
      `${changes.length} marker change(s); ${stale ? 'the roster moved, so the CLI is asked' : 'a phase changed, so one file is read'}`,
      'activity',
    );

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
    this.#deps.log.info(`${key} moved to ${lane}`, 'lanes');
    this.#broadcast();
  }

  /**
   * Where a session can be reached, and by whom. Every route the VS Code host plans is one only a client inside that
   * application can perform, so the plan goes back to the client that asked for it rather than being carried out here.
   */
  async #open(client: Connected, sessionId: string, extensionReady: boolean, handedOver = false): Promise<void> {
    const named = client.hello.hostId !== null && Object.hasOwn(this.#config.hosts, client.hello.hostId);
    const host = named ? this.#deps.registries.hosts.find((h) => h.id === client.hello.hostId) : undefined;

    // Only a host this configuration names: one left out of it was handed no settings, and reaching into an editor
    // on defaults nobody chose means reading another install's windows and bringing the wrong one forward.
    if (host === undefined) {
      client.send({
        type: 'notice',
        level: 'warning',
        message: 'This board is not running inside an application that can open a session.',
      });

      return;
    }

    const wasHistorical = this.#history.some((s) => s.sessionId === sessionId);
    // A card can have been drawn before this session resumed elsewhere. Never resume from a cached roster.
    await this.#refreshSessions(true);
    if (this.#disposed) return;
    const sessions = this.#sessions?.sessions ?? [];
    const live = sessions.find((s) => s.sessionId === sessionId && !s.finished);
    const historical = live ? undefined : this.#history.find((s) => s.sessionId === sessionId);
    if (!live && wasHistorical && (this.#sessions?.failures.length ?? 1) > 0) {
      client.send({ type: 'notice', level: 'warning', refusal: 'sessions-unreadable', message: 'Could not verify whether this session is active. Refresh the board and try again.' });
      return;
    }
    const readers = this.#readers();
    let resumeLease: number | undefined;
    if (historical) {
      const now = this.#deps.clock.now();
      for (const [id, until] of this.#resuming) if (until <= now) this.#resuming.delete(id);
      if (this.#resuming.has(sessionId)) {
        client.send({ type: 'notice', level: 'warning', refusal: 'resume-pending', message: 'This session is already being opened. Give its tab a moment to appear.' });
        return;
      }
      const agent = this.#deps.registries.agents.find((a) => a.id === historical.agent);
      const { pattern } = compilePattern(this.#config.branchIssuePattern);
      if (!agent?.canResume?.(historical, { ...readers, pattern })) {
        client.send({ type: 'notice', level: 'warning', refusal: 'history-unavailable', message: 'The saved transcript or its working directory is no longer available. Refresh the board.' });
        return;
      }
      if (historical.issueNumber !== null && sessions.some((s) => !s.finished && s.issueNumber === historical.issueNumber)) {
        client.send({ type: 'notice', level: 'warning', refusal: 'card-active', message: 'This card now has an active session. Refresh the board to open it.' });
        return;
      }
      // Reserve before window discovery yields: two editor clients may click the same saved session together.
      resumeLease = now + 60_000;
      this.#resuming.set(sessionId, resumeLease);
    }
    const [windows, surfaces] = await Promise.all([
      host.windows(
        sessions.find((session) => session.sessionId === sessionId),
        readers,
      ),
      host.surfaces(readers),
    ]);

    // A slow window lookup must not borrow or release a later click's reservation.
    if (resumeLease !== undefined && this.#resuming.get(sessionId) !== resumeLease) return;
    if (resumeLease !== undefined && this.#deps.clock.now() >= resumeLease - 30_000) {
      this.#resuming.delete(sessionId);
      client.send({ type: 'notice', level: 'warning', refusal: 'resume-pending', message: 'This resume request expired while locating its window. Refresh the board and try again.' });
      return;
    }

    const plan = host.plan({
      sessionId,
      sessions,
      ...(historical ? { historicalSession: historical } : {}),
      surfaces,
      window: windows.holding,
      liveRoots: windows.live.flatMap((window) => window.folders),
      liveWindows: windows.live,
      workspaceRoot: client.hello.workspaceRoot,
      extensionReady,
      handedOver,
      now: this.#deps.clock.now(),
    });

    if ('refusal' in plan) {
      if (historical) this.#resuming.delete(sessionId);
      this.#deps.log.info(`${client.hello.id} could not open ${sessionId}: ${plan.refusal}`, 'open');
      client.send({ type: 'notice', level: 'warning', message: plan.message, refusal: plan.refusal });

      return;
    }

    // Written down because an open is the board reaching into the developer's editor, and the log is where they
    // look when a click did not land — which is exactly the case where nothing else says what was decided.
    this.#deps.log.info(`${client.hello.id} opening ${sessionId} by ${plan.route}`, 'open');

    if (host.residentRoutes.includes(plan.route)) {
      if (!client.hello.residentRoutes.includes(plan.route)) {
        if (historical) this.#resuming.delete(sessionId);
        client.send({ type: 'notice', level: 'warning', message: 'Reload this editor to enable opening historical sessions.' });
        return;
      }
      if (plan.route === 'resume-here' || plan.route === 'resume-elsewhere') {
        // The fire deadline precedes lease expiry, leaving time for the new process to register before another click.
        plan.expiresAt = Math.min(plan.expiresAt, resumeLease! - 30_000);
      }
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
    const now = this.#deps.clock.now();
    const failures: ReadFailure[] = [...this.#configFailures, ...this.#historyFailures];

    // A stored configuration this hub would not run on. Said rather than swallowed: silently falling back to
    // defaults is how a board comes to report itself unconfigured with the developer's settings sitting on disk.
    if (this.#stored) {
      failures.push(this.#stored);
    }

    if (activity?.failure) {
      failures.push(activity.failure);
    }

    for (const [id, reading] of this.#readings) {
      if (reading.failure && !this.#riding(id, reading, now)) {
        failures.push(reading.failure);
      }
    }

    for (const failure of this.#sessions?.failures ?? []) {
      failures.push({ ...failure, subject: 'sessions' });
    }

    failures.push(...this.#triage.failures(), ...this.#actions.failures());

    const memory = this.#memory();
    const items = this.#items();
    const laned = assignLanes(
      mergeBoard(items?.cards ?? [], this.#sessions?.sessions ?? [], this.#history),
      {
        boardStatuses: this.#config.boardStatuses,
        statusLanes: this.#config.statusLanes,
        // Who the items were actually read for, which is not the setting the moment a developer changes it.
        logins: items?.owners ?? [],
      },
      memory,
    );

    // Attached after the lanes are settled, and neither changes them: triage labels a card and an action works on
    // what a card holds. Placement stays the developer's alone (R8).
    const lanes = this.#actions.decorate(
      withTriage(laned, this.#deps.triage.read(), this.#triage.running(), this.#deps.clock.now()),
    );

    return {
      lanes,
      issues: items
        ? {
            count: items.cards.length,
            matched: items.matched,
            totalAssigned: items.totalAssigned,
            notOnProject: items.notOnProject,
            truncated: items.truncated,
            fetchedAt: items.fetchedAt,
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
      // Deduplicated by what failed and how: fifteen cards failing one logged-out CLI is one condition, and R25 says
      // a condition belonging to the whole board is stated once above the lanes rather than fifteen times.
      failures: distinct(failures),
      stale:
        this.#sourcesRefused.length > 0 ||
        [...this.#readings.values()].some((reading) => reading.failure) ||
        (this.#sessions?.failures.length ?? 0) > 0,
      needs: this.#needs(),
      fetchedAt: new Date(now).toISOString(),
    };
  }

  /**
   * An unreachable source the board rides out rather than reports: the failure clears itself, it has not lasted a
   * minute, and there is a read behind it still worth looking at. `stale` still says the board could not refresh.
   */
  #riding(id: string, reading: SourceReading, now: number): boolean {
    const outage = this.#outages.get(id);

    return (
      reading.failure?.transient === true &&
      reading.items !== null &&
      outage !== undefined &&
      !outage.announced &&
      now - outage.since < OUTAGE_GRACE_MS
    );
  }

  /** What no client has given the hub yet, from the first source that is waiting on it (R26, R28). */
  #needs(): Snapshot['needs'] {
    const detected = [...this.#readings.values()].find((reading) => reading.needs)?.needs;

    return detected ? { logins: detected } : null;
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
   * The host whose answer this client gets about opening. Its own where it is resident in one. Where it is resident
   * in nothing — a browser board — the one configured host answers instead: that board reaches an editor by asking
   * the operating system for one rather than by being inside a window, so what it may open cannot depend on a
   * window being open at the time (R14, R36). Its click arrives back here as that editor's own `open`.
   */
  #hostFor(hello: ClientHello): HostAdapter | undefined {
    if (hello.hostId !== null) {
      return this.#deps.registries.hosts.find((host) => host.id === hello.hostId);
    }

    const configured = this.#deps.registries.hosts.filter((host) => Object.hasOwn(this.#config.hosts, host.id));

    return configured.length === 1 ? configured[0] : undefined;
  }

  /**
   * One snapshot, finished per client. What a board may open is its host's answer, and a notice is said once per
   * board — a second window has not read the first one's (R14, R25).
   */
  #sendTo(id: string, type: 'snapshot' | 'changed', base = this.snapshot()): void {
    const client = this.#clients.get(id);

    if (client === undefined) {
      return;
    }

    client.send({
      type,
      snapshot: {
        ...base,
        openable: this.#hostFor(client.hello)?.openable(
          this.#sessions?.sessions ?? [],
          base.lanes.flatMap((l) => l.cards).flatMap((c) => c.lastSession ?? []).filter((s) =>
            this.#deps.registries.agents.some((a) => a.id === s.agent && a.canResume !== undefined)),
        ) ?? [],
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

    // After the send, never before. `consider` starts a reading synchronously and that start broadcasts a fresh
    // snapshot saying so — sent from inside this call, it would be followed by `base`, which was taken before the
    // reading began. Every client's last word would then be that nothing is being read, until the reading finished.
    this.#triage.consider(base.lanes, this.#sourcesRead(), this.#watched());
    this.#actions.consider(
      base.lanes,
      this.#sessions?.sessions ?? [],
      this.#sourcesRead(),
      this.#sessions !== undefined && this.#sessions.failures.length === 0,
      this.#watched(),
    );
  }

  /**
   * Said once per machine, and held rather than sent: what a client is shown is assembled per client, and a notice
   * pushed from inside a pass would race the snapshot that pass is about to send.
   */
  #tellOnceAboutTriage(message: string): void {
    if (this.#deps.marks.read().triageToldAt !== null) {
      return;
    }

    this.#deps.marks.write({ ...this.#deps.marks.read(), triageToldAt: this.#deps.clock.now() });

    for (const client of this.#clients.values()) {
      client.send({ type: 'notice', level: 'info', message });
    }
  }

  /**
   * Said once per machine, the first time the board actually starts work on the developer's code. The setting is the
   * consent; this is the moment it becomes an agent editing a checkout, and a warning is what R32's line deserves.
   */
  #tellOnceAboutActions(message: string): void {
    if (this.#deps.marks.read().actionsToldAt !== null) {
      return;
    }

    this.#deps.marks.write({ ...this.#deps.marks.read(), actionsToldAt: this.#deps.clock.now() });

    for (const client of this.#clients.values()) {
      client.send({ type: 'notice', level: 'warning', message });
    }
  }

  /** Only a clean source read proves a card has left the board; a failed one re-renders the last good cards. */
  #sourcesRead(): boolean {
    const readings = [...this.#readings.values()];

    return readings.length > 0 && readings.every((reading) => reading.failure === null && reading.items !== null);
  }

  dispose(): void {
    this.#disposed = true;

    for (const client of this.#clients.values()) {
      client.unwatchLog?.();
      client.unwatchLog = null;
    }

    this.#triage.dispose();
    this.#actions.dispose();

    while (this.#timers.length > 0) {
      this.#deps.clock.clearInterval(this.#timers.pop()!);
    }

    while (this.#watchers.length > 0) {
      this.#watchers.pop()?.dispose();
    }

    this.#clients.clear();
  }
}

/** One entry per distinct condition. A cause that hit fifteen cards is one line above the lanes, not fifteen (R25). */
function distinct(failures: readonly ReadFailure[]): ReadFailure[] {
  const seen = new Map<string, ReadFailure>();

  for (const failure of failures) {
    const key = `${failure.subject}\u0000${failure.kind}`;

    if (!seen.has(key)) {
      seen.set(key, failure);
    }
  }

  return [...seen.values()];
}
