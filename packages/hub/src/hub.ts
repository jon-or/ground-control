import { assignLanes, mergeBoard, nextMemory, withCheckouts, withPlacement, withTriage } from '@ground-control/board';
import { compilePattern, dirKey, diskReaders, fillTemplate, fetchSessions, fetchSessionHistory, isAbsolute, newSessionValues, normalize, parseHubConfig, repositoryKey, repositoryOf, rosterIsStale, unreportedSessions } from '@ground-control/core';
import type { ActivityChange, Client, ClientHello, ClientMessage, HistoricalSession, HostAdapter, HostWindow, HubConfig, HubMessage, IssueCard, Lane, LaneId, Logger, MachineReaders, OpenRoute, ReadFailure, Session, SessionsSnapshot, Snapshot, SourceReading, WorkItems, WorkSource } from '@ground-control/core';
import { activityAcknowledgement, activityNotice, pruneMarkers, syncActivity } from './activityInstall.js';
import { IssueLookup } from './issueLookup.js';
import { makeIssueStore } from './issueStore.js';
import type { IssueStore } from './issueStore.js';
import type { ActivityState } from './activityInstall.js';
import { read } from './fs.js';
import type { LaneStore } from './lanes.js';
import { ActionRunner } from './actions.js';
import { makeActionStore } from './actionStore.js';
import { makeCheckoutStore } from './checkoutStore.js';
import type { CheckoutStore } from './checkoutStore.js';
import type { ActionStore } from './actionStore.js';
import { TriageRunner } from './triage.js';
import { makeTriageStore } from './triageStore.js';
import type { TriageStore } from './triageStore.js';
import { makeStatusStore, pruned, retaining } from './statusStore.js';
import type { StatusStore } from './statusStore.js';
import { afterInstall, announce } from './marks.js';
import type { MarkStore } from './marks.js';
import type { SettingsStore } from './settings.js';
import { configureHosts, configureSources, defaultConfig } from './registry.js';
import type { Registries } from './registry.js';
import { readLogTail } from './logger.js';
import { logPathOf } from './paths.js';

/** Inject the clock to test both polling intervals without waiting. */
export interface HubClock {
  now(): number;
  setInterval(fn: () => void, ms: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
}

export interface HubDeps {
  clock: HubClock;
  watch(dir: string, onChange: (changes: readonly ActivityChange[]) => void): { dispose(): void };
  /** Inject the home directory to isolate tests from developer files. */
  home: string;
  registries: Registries;
  lanes: LaneStore;
  marks: MarkStore;
  /** Persisted card triage (R38). */
  triage: TriageStore;
  /** Persisted card action runs (R39). */
  actions: ActionStore;
  /** Cached issue lookups for sessions that outlast assignment (R9). */
  issues: IssueStore;
  /** Retained phases preserve card attention after a session closes (R6). */
  status: StatusStore;
  /** Persisted user-selected checkouts for cards without sessions. */
  checkouts: CheckoutStore;
  /** Persisted client settings, also used when Chrome starts the hub. */
  settings: SettingsStore;
  /** Write hub.log and stream entries to subscribed clients. */
  log: Logger;
  /** Inject activity installation to isolate tests from agent settings. */
  syncActivity(registries: Registries, wanted: 'install' | 'remove', home: string, enabled?: ReadonlySet<string>): ActivityState;
}

interface Connected {
  hello: ClientHello;
  send(message: HubMessage): void;
  watching: boolean;
  /** Log subscription cleanup, or null when unsubscribed. */
  unwatchLog: (() => void) | null;
}

/** Track a source outage during the grace period before reporting it. */
interface Outage {
  since: number;
  retryAt: number;
  announced: boolean;
}

/** Coalesce repeated manual refreshes within this interval. */
const REFRESH_FLOOR_MS = 1000;

/** Refresh reason determines its minimum interval. */
type Reason = 'visible' | 'asked' | 'settings';

/** Minimum source age for a visibility-triggered refresh; prevents repeated GitHub calls while switching views (R35). */
const SOURCE_FLOOR_MS = 60_000;

/** Retain cached data during brief outages before reporting them (R25). */
const OUTAGE_GRACE_MS = 60_000;

/** Base retries on outage duration so manual refreshes do not increase the retry delay. */
function backoffMs(outageMs: number): number {
  return outageMs < 30_000 ? 5_000 : outageMs < 120_000 ? 15_000 : outageMs < 600_000 ? 60_000 : 120_000;
}

/** Interval for outage retries and suspend detection. */
const TICK_MS = 5_000;

/** Suppress duplicate starts per card and agent until expiry. Clients do not report start completion. */
const START_LEASE_MS = 10_000;

/** Suppress duplicate checkout opens while the code process starts. */
const OPEN_LEASE_MS = 3_000;

/** Treat a delayed tick as resume from suspend and refresh immediately. */
const WAKE_GAP_MS = 20_000;

/** Compare JSON settings independent of object key order; source-specific shapes are opaque to core. */
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
  issues: IssueStore = makeIssueStore(home),
  status: StatusStore = makeStatusStore(home),
  checkouts: CheckoutStore = makeCheckoutStore(home),
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
    issues,
    status,
    checkouts,
    settings,
    log,
    syncActivity: (regs, wanted, where, enabled) => syncActivity(regs.agents, wanted, where, false, enabled),
  };
}

/**
 * Coordinate source/agent reads, activity observation, local lane placement, and client snapshots. Poll only
 * while a board is watched. Local lane changes do not update GitHub item state (R7, R35).
 */
export class Hub {
  readonly #deps: HubDeps;
  readonly #clients = new Map<string, Connected>();
  readonly #watchers: { dispose(): void }[] = [];
  readonly #timers: NodeJS.Timeout[] = [];

  #config: HubConfig;
  #configFailures: ReadFailure[] = [];
  /** Rejected source settings; no readable source means the board is stale. */
  #sourcesRefused: ReadFailure[] = [];

  /** Retain each source's last successful read independently of other source failures (R24). */
  readonly #readings = new Map<string, SourceReading>();
  /** Track source outage start times, retry deadlines, and notification state. */
  readonly #outages = new Map<string, Outage>();
  #lastTickAt = 0;
  #sessions: SessionsSnapshot | undefined;
  #history: HistoricalSession[] = [];
  #historyFailures: ReadFailure[] = [];
  readonly #resuming = new Map<string, number>();
  /** In-flight starts keyed by card and agent until a session ID exists (mechanics M51). */
  readonly #starting = new Map<string, number>();
  /** In-flight checkout opens keyed by card across clients. */
  readonly #opening = new Map<string, number>();
  #sourcesInFlight: Promise<void> | undefined;
  #sessionsInFlight: Promise<void> | undefined;
  #lastReadAt = 0;
  #lastSourceReadAt = 0;
  /** An empty roster with agent failures suppresses event-triggered retries. */
  #sessionsUnreadable = false;
  /** Last logged agent failures, keyed by subject and kind; see #logSessionRead. */
  #saidAboutSessions = '';
  /** Wait for explicit activity settings before writing to agents. */
  #activity: ActivityState | null = null;
  #configured = false;
  /** A stored configuration this hub would not run on. Shown until a client pushes one, which is what replaces it. */
  #stored: ReadFailure | null = null;
  #installedAt = 0;
  #disposed = false;
  readonly #triage: TriageRunner;
  readonly #actions: ActionRunner;
  readonly #issues: IssueLookup;

  constructor(deps: HubDeps) {
    this.#deps = deps;

    // Load saved settings so Chrome can start a configured hub without an editor open (R35, R36).
    const stored = deps.settings.read();

    this.#config = stored && 'config' in stored ? stored.config : defaultConfig(deps.registries, diskReaders(deps.home));
    this.#stored = stored && 'failure' in stored ? stored.failure : null;
    // Apply stored settings once; new connections must not replace their validation results.
    this.#configFailures = this.#applyConfig();
    this.#triage = new TriageRunner({
      home: deps.home,
      store: deps.triage,
      log: deps.log,
      agents: deps.registries.agents,
      sources: deps.registries.sources,
      now: () => deps.clock.now(),
      changed: () => this.#broadcast(),
      announce: (message) => this.#notifyTriageOnce(message),
    });
    this.#triage.configure(this.#config.triage, this.#config.agents, this.#config.statusLanes, this.#triageSources());
    this.#actions = new ActionRunner({
      home: deps.home,
      store: deps.actions,
      log: deps.log,
      agents: deps.registries.agents,
      sources: deps.registries.sources,
      now: () => deps.clock.now(),
      changed: () => this.#broadcast(),
      announce: (message) => this.#notifyActionsOnce(message),
      // Broadcast manual action refusals because the runner does not identify the requesting client (R25).
      notify: (message) => {
        for (const client of this.#clients.values()) {
          client.send({ type: 'notice', level: 'info', message });
        }
      },
    });
    this.#actions.configure(this.#config.actions, this.#config.agents);
    this.#issues = new IssueLookup({
      store: deps.issues,
      sources: () => deps.registries.sources.filter((source) => Object.hasOwn(this.#config.sources, source.id)),
      log: deps.log,
      now: () => deps.clock.now(),
      changed: () => this.#broadcast(),
    });
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
    this.#deps.log.info(`${client.id} disconnected; ${this.#clients.size} clients remain`, 'clients');
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

        // Acknowledge explicit setting changes, not settings restated on every connection (R34).
        if (!message.acknowledge) {
          return;
        }

        // Report rejected setting changes even when no board is open (R34).
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

        // Show cached data immediately while refreshing.
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
        // Validate and rate-limit manual triage requests because classification uses paid resources.
        const refused = this.#triage.retriage(this.snapshot().lanes, message.key);

        if (refused) {
          connected.send({ type: 'notice', level: 'info', message: refused.message });
        }

        return;
      }

      case 'runAction': {
        // Manual actions require fresh context and the same safety checks as automatic actions.
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

      case 'openCheckout':
        void this.#openCheckout(connected, message.key);

        return;

      case 'setCheckout':
        this.#setCheckout(connected, message.key, message.root);

        return;

      case 'startSession':
        this.#startSession(connected, message.key, message.agent, message.extensionReady);

        return;
    }
  }

  /** Start a user-requested session in the requesting window. Automatic action limits do not apply (R33); cards may have multiple sessions (R3). */
  #startSession(client: Connected, key: string, agent: string, extensionReady: boolean): void {
    const host = this.#hostFor(client.hello);

    if (host?.planStart === undefined) {
      client.send({ type: 'notice', level: 'warning', message: 'Starting a session requires a connected editor.' });

      return;
    }

    const card = this.snapshot().lanes.flatMap((lane) => lane.cards).find((candidate) => candidate.key === key);
    const root = card?.checkout?.root;

    if (card === undefined || root === undefined) {
      client.send({
        type: 'notice',
        level: 'warning',
        refusal: 'no-checkout',
        message: 'This card has no checkout to start a session in. Choose a checkout for this card.',
      });

      return;
    }

    // Unassigned issue cards are archived and read-only (R9). Recheck because the client snapshot may predate unassignment.
    if (card.unassigned === true) {
      client.send({ type: 'notice', level: 'warning', message: 'That issue is no longer assigned to you, so the board will not start work on it.' });

      return;
    }

    // Deduplicate starts by card and agent until a session ID exists (M51). Different agents may start independently.
    const now = this.#deps.clock.now();
    const startKey = `${key}:${agent}`;

    for (const [held, until] of this.#starting) {
      if (until <= now) this.#starting.delete(held);
    }

    if (this.#starting.has(startKey)) {
      client.send({ type: 'notice', level: 'warning', message: `A ${agent} session is already being started for this card. Wait for its tab to open.` });

      return;
    }

    const template = this.#config.newSession.prompt;
    const plan = host.planStart({
      key,
      agent,
      root,
      // An empty prompt still starts a manual session; automated actions require a prompt (R39).
      prompt: template.trim().length === 0 ? null : fillTemplate(template, newSessionValues(card, root)),
      workspaceRoot: client.hello.workspaceRoot,
      extensionReady,
    });

    if ('refusal' in plan) {
      this.#deps.log.info(`${client.hello.id} could not start ${agent} for ${key}: ${plan.refusal}`, 'open');
      client.send({ type: 'notice', level: 'warning', message: plan.message, refusal: plan.refusal });

      return;
    }

    // Session starts require a resident client; an external process cannot invoke window commands (M26).
    if (!host.residentRoutes.includes(plan.route) || !client.hello.residentRoutes.includes(plan.route)) {
      client.send({ type: 'notice', level: 'warning', message: 'Reload this editor to start a session from a card.' });

      return;
    }

    this.#starting.set(startKey, now + START_LEASE_MS);
    this.#deps.log.info(`${client.hello.id} starting a ${agent} session in ${root} for ${key}`, 'open');
    client.send({ type: 'perform', route: plan });
  }

  /** Validate the selected checkout against the card repository before saving it, so invalid selections report their cause. */
  #setCheckout(client: Connected, key: string, root: string): void {
    const card = this.snapshot().lanes.flatMap((lane) => lane.cards).find((candidate) => candidate.key === key);

    if (card === undefined) {
      client.send({ type: 'notice', level: 'warning', message: 'This card is no longer on the board. Refresh and try again.' });

      return;
    }

    const readers = this.#readers();
    const wanted = card.issue === null ? null : repositoryKey(card.issue.url);
    const chosen = normalize(root);

    // Require absolute paths because the hub and editor have different working directories.
    if (!isAbsolute(chosen) || wanted === null || repositoryOf(chosen, readers.readText) !== wanted) {
      client.send({
        type: 'notice',
        level: 'warning',
        message: `${root} is not a checkout of ${card.issue?.repository ?? 'this card’s repository'}. Choose a checkout for this issue.`,
      });

      return;
    }

    if (!this.#deps.checkouts.write(key, chosen)) {
      client.send({ type: 'notice', level: 'warning', message: 'Could not save the checkout. Check write access to the hub directory.' });

      return;
    }

    this.#deps.log.info(`${client.hello.id} set the checkout for ${key} to ${chosen}`, 'open');
    this.#broadcast();
  }

  /** Select a client for this host: requester first, then one on the checkout, then any compatible client. */
  #residentFor(route: OpenRoute['route'], hostId: string, asked: Connected, root: string): Connected | undefined {
    if (asked.hello.residentRoutes.includes(route)) {
      return asked;
    }

    const able = [...this.#clients.values()].filter(
      (candidate) => candidate.hello.hostId === hostId && candidate.hello.residentRoutes.includes(route),
    );

    return able.find((candidate) => candidate.hello.workspaceRoot !== null && dirKey(candidate.hello.workspaceRoot) === dirKey(root)) ?? able[0];
  }

  /** Open a checkout without starting an agent, using a host plan and resident client. */
  async #openCheckout(client: Connected, key: string): Promise<void> {
    const host = this.#hostFor(client.hello);

    if (host?.planCheckout === undefined) {
      client.send({ type: 'notice', level: 'warning', message: 'Opening a checkout requires a connected editor.' });

      return;
    }

    const card = this.snapshot().lanes.flatMap((lane) => lane.cards).find((candidate) => candidate.key === key);
    const root = card?.checkout?.root;

    if (root === undefined) {
      client.send({
        type: 'notice',
        level: 'warning',
        refusal: 'no-checkout',
        message: 'This card has no checkout to open. Choose a checkout for this card.',
      });

      return;
    }

    const now = this.#deps.clock.now();

    for (const [held, until] of this.#opening) {
      if (until <= now) this.#opening.delete(held);
    }

    // Suppress duplicate opens and limit browser-triggered code processes while focus requests are pending.
    if (this.#opening.has(key)) {
      // Notify duplicate clicks, but suppress per-card notices for rate-limited requests.
      if (client.hello.hostId !== null) {
        client.send({ type: 'notice', level: 'info', message: 'This window is already opening.' });
      }

      return;
    }

    const readers = this.#readers();
    host.prime(readers);
    const windows = await host.windows(undefined, readers);

    if (this.#disposed) {
      return;
    }

    const plan = host.planCheckout({
      key,
      root,
      workspaceRoot: client.hello.workspaceRoot,
      liveWindows: [...windows.live, ...this.#boardWindows()],
    });

    if ('refusal' in plan) {
      this.#deps.log.info(`${client.hello.id} could not open ${root}: ${plan.refusal}`, 'open');
      client.send({ type: 'notice', level: 'warning', message: plan.message, refusal: plan.refusal });

      return;
    }

    // Run resident routes in the requesting editor, or another connected editor for browser requests (R41).
    if (host.residentRoutes.includes(plan.route)) {
      const performer = this.#residentFor(plan.route, host.id, client, root);

      if (performer === undefined) {
        // Report the missing capability, including when an outdated editor handles a browser request.
        const anyEditor = [...this.#clients.values()].some((candidate) => candidate.hello.hostId !== null);

        client.send({
          type: 'notice',
          level: 'warning',
          message: anyEditor
            ? 'Reload this editor to open a card’s checkout.'
            : 'Ground Control is not running in an editor. Open the board in VS Code to open a checkout from here.',
        });

        return;
      }

      this.#opening.set(key, now + OPEN_LEASE_MS);
      this.#deps.log.info(`${performer.hello.id} opening ${root} for ${key}, asked by ${client.hello.id}`, 'open');
      performer.send({ type: 'perform', route: plan });

      return;
    }

    this.#opening.set(key, now + OPEN_LEASE_MS);
    this.#deps.log.info(`${client.hello.id} opening ${root} for ${key}`, 'open');
    await host.open?.(plan, readers);
  }

  /** Include connected board windows. Host discovery may list only agent windows and miss an existing empty editor. */
  #boardWindows(): HostWindow[] {
    return [...this.#clients.values()].flatMap((candidate) =>
      candidate.hello.workspaceRoot === null ? [] : [{ folders: [candidate.hello.workspaceRoot] }],
    );
  }

  // — configuration —

  /** Apply client settings even without an open board so activity removal takes effect (R34). Return the installation result, or null if unchanged. */
  configure(raw: unknown): ActivityState | null {
    const parsed = parseHubConfig(raw);

    // Reject the entire configuration to avoid mixing clients' settings, including executable paths.
    if ('failure' in parsed) {
      this.#configFailures = [parsed.failure];
      this.#deps.log.warn(`client settings rejected: ${parsed.failure.message}`, 'config');
      this.#broadcast();

      return null;
    }

    const before = this.#config;

    this.#config = parsed.config;

    if (same(before, parsed.config)) {
      this.#deps.log.debug('settings restated unchanged', 'config');
    } else {
      // Log the setting change before applying a lower log level.
      this.#deps.log.info(`client updated settings; log level: ${parsed.config.logLevel}`, 'config');
    }

    const sessionsChanged = !same(before.agents, parsed.config.agents) || before.branchIssuePattern !== parsed.config.branchIssuePattern;
    if (sessionsChanged) {
      this.#sessions = undefined;
      this.#history = [];
      this.#historyFailures = [];
    }
    this.#configFailures = this.#applyConfig();
    this.#stored = null;

    // Persist only settings accepted by the schema and adapters, so later browser starts do not inherit rejected values.
    if (this.#configFailures.length === 0) {
      this.#deps.settings.write(parsed.config);
    }

    const first = !this.#configured;
    this.#configured = true;

    // Wait for explicit activity settings before installation (R34). Reinstall when settings or configured agents change, bypassing cached results.
    const agents = (config: HubConfig): string => config.agents.map((agent) => agent.id).sort().join(',');
    const changed =
      first ||
      before.installActivity !== parsed.config.installActivity ||
      !same(before.sessionHooks ?? {}, parsed.config.sessionHooks ?? {}) ||
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

    // Broadcast corrected settings immediately; refresh throttling could otherwise retain an obsolete error.
    this.#broadcast();
    // Refresh sources only when their settings change; every client restates settings on connection.
    const reason = same(before.sources, parsed.config.sources) ? 'visible' : 'settings';
    if (sessionsChanged) {
      void this.#refreshSources(reason);
      void this.#refreshSessions(true);
    } else {
      void this.refresh(reason);
    }

    return resynced;
  }

  /** Configure each adapter and report unknown IDs (R25). */
  #applyConfig(): ReadFailure[] {
    this.#deps.log.setLevel(this.#config.logLevel);
    this.#actions?.configure(this.#config.actions, this.#config.agents);

    const refused = configureSources(this.#deps.registries, this.#config.sources);

    // Immediately clear cached cards for omitted or rejected sources, even when polling is inactive.
    for (const id of [...this.#readings.keys()]) {
      if (!Object.hasOwn(this.#config.sources, id) || refused.some((failure) => failure.subject === id)) {
        this.#readings.delete(id);
        // Clear the removed source's outage too, or it would keep triggering retries for the remaining sources.
        this.#outages.delete(id);
      }
    }

    this.#sourcesRefused = refused;
    this.#triage?.configure(this.#config.triage, this.#config.agents, this.#config.statusLanes, this.#triageSources());

    return [...configureHosts(this.#deps.registries, this.#config.hosts), ...refused];
  }

  #triageSources(): ReadonlySet<string> {
    return new Set(Object.keys(this.#config.sources).filter((id) => !this.#sourcesRefused.some((failure) => failure.subject === id)));
  }

  /** Cache completed activity installation results. Retry busy results because another process held the lock (R25). */
  #ensureActivity(): ActivityState | null {
    return this.#configured && (this.#activity === null || this.#activity.plan === 'busy')
      ? this.#installActivity()
      : this.#activity;
  }

  #installActivity(): ActivityState {
    // Reconcile every adapter: install selected configured agents and remove all other owned hooks (R34).
    this.#activity = this.#config.installActivity
      ? this.#deps.syncActivity(
          this.#deps.registries,
          'install',
          this.#deps.home,
          new Set(this.#config.agents.filter((agent) => this.#config.sessionHooks?.[agent.id] !== false).map((agent) => agent.id)),
        )
      : this.#deps.syncActivity(this.#deps.registries, 'remove', this.#deps.home);

    return this.#activity;
  }

  // — polling —

  /**
   * Read a disk tail and subscribe only while this client requests logs. Disk backfill includes prior hub
   * output after restart. A log subscription does not enable board polling (R35).
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

    // Subscribe before logging so the viewer receives that entry.
    client.unwatchLog = this.#deps.log.watch((entry) => client.send({ type: 'log', entries: [entry] }));
    this.#deps.log.debug(`${client.hello.id} opened its log viewer`, 'clients');
  }

  #watched(): boolean {
    return [...this.#clients.values()].some((client) => client.watching);
  }

  /** Poll only while watched. Preserve timers when settings are unchanged so reconnects do not postpone refreshes. */
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

  /** Refresh after suspend and retry source outages between normal polls. */
  #tick(): void {
    const now = this.#deps.clock.now();
    const gap = now - this.#lastTickAt;
    const slept = gap > TICK_MS + WAKE_GAP_MS;

    this.#lastTickAt = now;

    if (slept) {
      this.#deps.log.info(`polling gap: ${Math.round(gap / 1000)}s; refreshing all sources and sessions`, 'loop');
      // Restart outage grace periods after suspend and retry immediately. Keep previously reported outages visible.
      for (const outage of this.#outages.values()) {
        outage.since = now;
        outage.retryAt = now;
      }

      void this.#refreshSources('asked');
      void this.#refreshSessions();

      return;
    }

    // Report expired grace periods on the tick; pending or delayed requests could otherwise suppress the notice indefinitely.
    const overdue = [...this.#outages.values()].filter(
      (outage) => !outage.announced && now - outage.since >= OUTAGE_GRACE_MS,
    );

    for (const outage of overdue) {
      outage.announced = true;
    }

    if (overdue.length > 0) {
      this.#deps.log.warn(`${overdue.length} source(s) unreachable for over a minute; displaying failures`, 'sources');
      this.#broadcast();
    }

    if ([...this.#outages.values()].some((outage) => outage.retryAt <= now)) {
      void this.#refreshSources('asked');
    }
  }

  /** Watch only configured agents with activity signals. Recreate watchers when the configured agent set changes. */
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

  /** Read the shared live roster; clients must not spawn duplicate CLI readers. */
  async roster(): Promise<readonly Session[] | null> {
    await this.#refreshSessions(true);

    return this.#sessions && this.#sessions.failures.length === 0 ? this.#sessions.sessions : null;
  }

  /** Refresh work sources and sessions using their respective minimum intervals. */
  refresh(reason: Reason = 'visible'): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve();
    }

    const now = this.#deps.clock.now();
    const reads = [this.#refreshSources(reason)];

    // Throttle manual roster refreshes to avoid duplicate CLI processes (M2).
    if (now - this.#lastReadAt >= REFRESH_FLOOR_MS) {
      this.#lastReadAt = now;
      reads.push(this.#refreshSessions());
    }

    return Promise.all(reads).then(() => undefined);
  }

  /** Use cached sources for recent visibility changes. Throttle manual refreshes; changed settings require a new read after any in-flight request. */
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

  /** Queue another roster read when an event postdates the current read. Timer and manual requests share the current read. */
  #refreshSessions(again = false): Promise<void> {
    if (this.#sessionsInFlight) {
      return again ? this.#sessionsInFlight.then(() => this.#refreshSessions()) : this.#sessionsInFlight;
    }

    this.#sessionsInFlight = this.#readSessions().finally(() => {
      this.#sessionsInFlight = undefined;
    });

    return this.#sessionsInFlight;
  }

  /** Read configured sources concurrently. */
  async #readSources(): Promise<void> {
    const sources = this.#deps.registries.sources.filter((source) =>
      Object.hasOwn(this.#config.sources, source.id),
    );

    await Promise.all(sources.map((source) => this.#readSource(source)));

    if (this.#disposed) {
      return;
    }

    this.#considerIssues();
    this.#broadcast();
  }

  /**
   * Record source metadata and look up issue numbers referenced only by sessions. Wait for the first
   * successful source read: initial empty items must not archive assigned cards or clear their lane placement
   * (R8, R24).
   */
  #considerIssues(): void {
    const items = this.#items();

    if (items === null) {
      return;
    }

    this.#issues.consider(items.cards, this.#sessions?.sessions ?? [], new Set(items.cards.map((card) => card.number)));
  }

  async #readSource(source: WorkSource): Promise<void> {
    const startedAt = this.#deps.clock.now();
    const reading = await source.read().catch(
      (error: unknown): SourceReading => ({
        items: null,
        // Convert source exceptions to reported failures so other sources still update.
        failure: {
          subject: source.id,
          kind: 'source-failed',
          message: `${source.displayName} could not be read: ${String(error)}`,
          remedy: 'Refresh the board. If the error persists, check the hub log.',
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

    // Retain cached cards after read failures (R24). Clear cards when rejected settings disable the source.
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

  /** Combine the last successful read from each source. */
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
      // Use the oldest source timestamp for board freshness.
      fetchedAt: read.map((items) => items.fetchedAt).sort()[0]!,
    };
  }

  async #readSessions(): Promise<void> {
    const readers = this.#readers();
    const config = { agents: this.#config.agents, branchIssuePattern: this.#config.branchIssuePattern };
    const current = () => !this.#disposed && same(config, { agents: this.#config.agents, branchIssuePattern: this.#config.branchIssuePattern });

    // Preload routing data to avoid its cold-read cost on clicks.
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

    // Preserve successful agent reads when another fails and refresh activity after polling. Exclude classification sessions even if adapter filtering changes (R2, M31).
    const ours = this.#triage.sessionIds();

    if (ours.size > 0) {
      snapshot = { ...snapshot, sessions: snapshot.sessions.filter((session) => !ours.has(session.sessionId)) };
    }

    const liveIds = new Set(snapshot.sessions.filter((s) => !s.finished).map((s) => `${s.agent}:${s.sessionId}`));
    const endedIssues = new Set(this.#sessions?.sessions.filter((s) => !s.finished && !liveIds.has(`${s.agent}:${s.sessionId}`)).map((s) => s.issueNumber));
    this.#sessions = { ...snapshot, sessions: snapshot.sessions.map((session) => this.#withActivity(session)) };
    this.#retain();
    this.#sessionsUnreadable = snapshot.sessions.length === 0 && snapshot.failures.length > 0;
    this.#logSessionRead(snapshot.failures, snapshot.sessions.length, this.#deps.clock.now() - startedAt);
    // Stable cards keep their rows while history refreshes. A just-ended attempt needs a fresh history read,
    // otherwise the older attempt would briefly appear in its place.
    this.#history = snapshot.failures.length > 0 ? [] : this.#history.filter((s) => !endedIssues.has(s.issueNumber));
    this.#historyFailures = [];

    this.#considerIssues();

    // Publish live rows even if history is slow or fails. An incomplete roster cannot establish inactivity.
    this.#broadcast();
    if (snapshot.failures.length > 0) return;
    const history = await fetchSessionHistory(config, this.#deps.registries.agents, readers);
    if (!current()) return;
    this.#history = history.sessions;
    this.#historyFailures = history.failures;
    // Prune retained phases only after complete live and history reads establish that sessions are absent.
    if (history.failures.length === 0) {
      this.#deps.status.write(pruned(this.#deps.status.read(), this.#sessions?.sessions ?? [], this.#history));
    }

    this.#broadcast();
  }

  /** Log reads at debug level. Warn only when the set of agent failures changes to avoid repeated poll warnings. */
  #logSessionRead(failures: readonly ReadFailure[], listed: number, took: number): void {
    this.#deps.log.debug(`${listed} sessions in ${took}ms`, 'sessions');

    // Deduplicate by subject and kind; adapter error text can vary between identical failures.
    const key = failures.map((failure) => `${failure.subject}/${failure.kind}`).join(' ');

    if (key === this.#saidAboutSessions) {
      return;
    }

    this.#saidAboutSessions = key;

    // Log recovery when the previous failure set clears.
    if (key === '') {
      this.#deps.log.info('all agent reads recovered', 'sessions');

      return;
    }

    this.#deps.log.warn(failures.map((failure) => `${failure.subject}: ${failure.message}`).join('; '), 'sessions');
  }

  #readers(): MachineReaders {
    return diskReaders(this.#deps.home);
  }

  // — the activity signal —

  /** Refresh the roster for ended or unknown sessions; known-session phase updates require only marker reads. */
  #onActivity(changes: readonly ActivityChange[]): void {
    // Ignore activity while no board is visible to avoid unnecessary CLI reads (R35).
    if (this.#disposed || !this.#watched()) {
      return;
    }

    const known = new Set(this.#sessions?.sessions.map((session) => session.sessionId) ?? []);
    const stale = rosterIsStale(changes, known, (id) => this.#phaseOf(id) !== null);

    this.#deps.log.debug(
      `${changes.length} marker change(s); ${stale ? 'the roster moved, so the CLI is asked' : 'a phase changed, so one file is read'}`,
      'activity',
    );

    // After an empty roster with agent failures, retry on the timer instead of every marker batch.
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
    this.#retain();

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

  /** Retain phases before session-end marker deletion, so closing a process does not clear attention (R6). */
  #retain(): void {
    this.#deps.status.write(retaining(this.#deps.status.read(), this.#sessions?.sessions ?? []));
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

  /** Plan session routes in the host and send resident routes to the requesting client. */
  async #open(client: Connected, sessionId: string, extensionReady: boolean, handedOver = false): Promise<void> {
    const named = client.hello.hostId !== null && Object.hasOwn(this.#config.hosts, client.hello.hostId);
    const host = named ? this.#deps.registries.hosts.find((h) => h.id === client.hello.hostId) : undefined;

    // Use only configured hosts; defaults could select windows from another editor installation.
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
        client.send({ type: 'notice', level: 'warning', refusal: 'resume-pending', message: 'This session is already being opened. Wait for its tab to open.' });
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

    // Log the selected route to diagnose requests that fail to open the session.
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

  /** Build the board snapshot, retaining cached source data alongside read failures (R24). */
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
      if (reading.failure && !this.#withinOutageGrace(id, reading, now)) {
        failures.push(reading.failure);
      }
    }

    for (const failure of this.#sessions?.failures ?? []) {
      failures.push({ ...failure, subject: 'sessions' });
    }

    failures.push(...this.#triage.failures(), ...this.#actions.failures());

    const memory = this.#memory();
    const items = this.#items();
    const cards = items?.cards ?? [];
    const sessions = this.#sessions?.sessions ?? [];
    // Empty until a source has read: with no assigned set to compare against, every session-named number would read
    // as an issue nobody assigned, and the board would archive itself on the way up (R24).
    const unassigned = items === null ? new Map<number, IssueCard>() : this.#issues.known(sessions, new Set(cards.map((card) => card.number)));
    const laned = assignLanes(
      mergeBoard(cards, sessions, this.#history, unassigned, this.#deps.status.read()),
      {
        boardStatuses: this.#config.boardStatuses,
        statusLanes: this.#config.statusLanes,
        // Use the logins from the completed source read, which may predate changed settings.
        logins: items?.owners ?? [],
      },
      memory,
    );

    // Add triage, checkouts, then actions without changing lane placement (R8). Actions require checkout data first.
    const lanes = this.#actions.decorate(
      withCheckouts(
        withTriage(laned, this.#deps.triage.read(), this.#triage.running(), this.#deps.clock.now()),
        this.#deps.checkouts.read(),
        this.#readers(),
      ),
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
      // Filled in per client: what a board may open or start is the answer of the host it is running inside (R14).
      openable: [],
      startable: [],
      hooks: null,
      triage: this.#triage.status(),
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

  /** Suppress transient failure notices during the grace period while cached data exists. The snapshot still reports stale data. */
  #withinOutageGrace(id: string, reading: SourceReading, now: number): boolean {
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

  /** Persist computed board state separately from snapshot reads, which must not change saved lane placements. */
  #persist(lanes: Lane[]): void {
    const memory = this.#memory();

    // Only a clean session read proves a session is gone; a failed one reports none, and would discard its placement.
    const sessionsRead = this.#sessions !== undefined && this.#sessions.failures.length === 0;

    this.#deps.lanes.write(nextMemory(lanes, memory, sessionsRead, this.#deps.clock.now()));

    const activity = this.#activity;

    if (activity === null) {
      return;
    }

    const next = afterInstall(this.#deps.marks.read(), activity.wanted, activity.added, this.#deps.clock.now());

    this.#deps.marks.write(next);
    this.#installedAt = next.installedAt ?? 0;
  }

  /** Return installation notices not yet acknowledged by this client (R25). */
  #noticeFor(id: string): { notice: string } | null {
    if (this.#activity === null) {
      return null;
    }

    const notice = activityNotice({
      plan: this.#activity.plan,
      wanted: this.#activity.wanted,
      added: this.#activity.added,
      removed: this.#activity.removed ?? 0,
      unreported: unreportedSessions(
        (this.#sessions?.sessions ?? []).filter((session) => this.#config.sessionHooks?.[session.agent] !== false),
        this.#installedAt,
      ),
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

  /** Use the client's resident host, or the sole configured host for Chrome. Browser routes must not require an already open editor window (R14, R36). */
  #hostFor(hello: ClientHello): HostAdapter | undefined {
    if (hello.hostId !== null) {
      return this.#deps.registries.hosts.find((host) => host.id === hello.hostId);
    }

    const configured = this.#deps.registries.hosts.filter((host) => Object.hasOwn(this.#config.hosts, host.id));

    return configured.length === 1 ? configured[0] : undefined;
  }

  /** Add host-specific opening capabilities and unacknowledged notices per client (R14, R25). */
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
        // Offer start actions only when this client can perform them; Chrome may resolve a host but cannot start sessions (R42).
        startable: client.hello.residentRoutes.includes('start-session')
          ? [...(this.#hostFor(client.hello)?.startable?.() ?? [])]
          : [],
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

    // Send this snapshot before consider can broadcast a newer triage state; reversing the order would display stale state.
    this.#triage.consider(base.lanes, this.#sourcesRead(), this.#watched());
    this.#actions.consider(
      base.lanes,
      this.#sessions?.sessions ?? [],
      this.#sourcesRead(),
      this.#sessions !== undefined && this.#sessions.failures.length === 0,
      this.#watched(),
    );
  }

  /** Queue the one-time triage notice for per-client snapshots to avoid racing the current broadcast. */
  #notifyTriageOnce(message: string): void {
    if (this.#deps.marks.read().triageToldAt !== null) {
      return;
    }

    this.#deps.marks.write({ ...this.#deps.marks.read(), triageToldAt: this.#deps.clock.now() });

    for (const client of this.#clients.values()) {
      client.send({ type: 'notice', level: 'info', message });
    }
  }

  /** Queue the one-time notice after the first action starts editing a checkout (R32). */
  #notifyActionsOnce(message: string): void {
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
    this.#issues.dispose();

    while (this.#timers.length > 0) {
      this.#deps.clock.clearInterval(this.#timers.pop()!);
    }

    while (this.#watchers.length > 0) {
      this.#watchers.pop()?.dispose();
    }

    this.#clients.clear();
  }
}

/** Deduplicate conditions across cards for display above the lanes (R25). */
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
