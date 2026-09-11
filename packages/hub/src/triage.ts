import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { triageMode } from '@ground-control/core';
import type { AgentAdapter, IssueCard, Lane, LaneId, Logger, ReadFailure, Snapshot, TriageSettings, WorkSource } from '@ground-control/core';
import {
  buildTriagePrompt,
  dueForTriage,
  evidenceOf,
  forgetTriage,
  nextTriageState,
  readTriageResult,
  resolveTriage,
  settledAction,
  triageJsonSchema,
  triggerOf,
  TRIAGE_SYSTEM_PROMPT,
  withTriageFailure,
  TRIAGE_REVISION,
  withTriaged,
} from '@ground-control/board';
import type { TriageStore } from './triageStore.js';
import { TriageUsage } from './triageUsage.js';

export interface TriageDeps {
  /** Ground Control state directory: usage record and classifier working directory. */
  stateDir: string;
  store: TriageStore;
  /** Log classification duration and outcome. */
  log: Logger;
  /** Notify once per machine that triage uses paid resources and sends card text to an API (R25, R38). */
  announce(message: string): void;
  agents: readonly AgentAdapter[];
  sources: readonly WorkSource[];
  now(): number;
  /** Redraw when triage starts or completes; may re-enter consider. */
  changed(): void;
}

/** Card context for triage, keyed like lane placement. */
interface Due {
  key: string;
  card: IssueCard;
  agent: AgentAdapter;
  source: WorkSource;
  path: string;
  model: string | null;
}

/** Minimum interval between manual triage requests for one card. */
const RETRIAGE_COOLDOWN_MS = 30_000;

/** Classify cards with bounded concurrency without changing lane placement. Exclude classification sessions from the roster. */
export class TriageRunner {
  readonly #deps: TriageDeps;
  readonly #running = new Set<string>();
  readonly #sessions = new Set<string>();
  readonly #inFlight = new Map<string, AbortController>();
  readonly #asked = new Map<string, number>();
  readonly #automatic = new Set<string>();
  readonly #usage: TriageUsage;
  #usageFailed = false;

  #settings: TriageSettings = { enabled: false, concurrency: 1, timeoutMs: 180_000 };
  /** Use the same status mapping as lane assignment (R38). */
  #statusLanes: Readonly<Record<string, LaneId>> = {};
  #agentPaths = new Map<string, { path: string; model: string | null }>();
  #sourceIds: ReadonlySet<string> = new Set();
  #disposed = false;
  #considering = false;
  /** Deliberately cancelled keys do not count as failed attempts. */
  readonly #stoodDown = new Set<string>();

  constructor(deps: TriageDeps) {
    this.#deps = deps;
    this.#usage = new TriageUsage(deps.stateDir);
  }

  status(): NonNullable<Snapshot['triage']> {
    const mode = triageMode(this.#settings);
    const capability = this.#capabilityFailure();
    const count = this.#usage.read(this.#deps.now());
    let message: string | null = null;
    if (mode === 'off') message = 'Card triage is off.';
    else if (capability !== null) message = `${capability.message} ${capability.remedy}`;
    else if (mode === 'manual') message = 'Card triage is manual. Read a card from its own control.';
    else if (this.#usageFailed || count === null) message = 'Automatic triage paused because its usage record could not be read or saved. Repair triage-usage.json in the Ground Control state directory and restart the hub. Manual requests remain available.';
    else if (count.length >= (this.#settings.dailyLimit ?? 100)) message = 'Automatic triage limit reached for the rolling 24-hour window. Manual requests remain available.';
    return { mode, message, canRequest: mode !== 'off' && capability === null };
  }

  /** Card keys currently being classified. */
  running(): ReadonlySet<string> {
    return this.#running;
  }

  /** Expose triage failures for deduplicated display above the board (R25). */
  failures(): ReadFailure[] {
    return Object.values(this.#deps.store.read().failures).map((failure) => ({
      subject: 'triage',
      kind: failure.kind,
      message: `A card could not be triaged: ${failure.message}`,
      remedy: 'Previous triage results are retained. Use the card’s triage retry control.',
    }));
  }

  /** Exclude this runner's sessions even if adapter filtering changes (M31). */
  sessionIds(): ReadonlySet<string> {
    return this.#sessions;
  }

  /** Apply settings and cancel pending work when disabled. */
  configure(
    settings: TriageSettings,
    agents: readonly { id: string; path: string; model?: string | undefined }[],
    statusLanes: Readonly<Record<string, LaneId>>,
    sourceIds: ReadonlySet<string>,
  ): void {
    this.#settings = settings;
    this.#statusLanes = statusLanes;
    this.#agentPaths = new Map(agents.map((agent) => [agent.id, { path: agent.path, model: agent.model ?? null }]));
    this.#sourceIds = sourceIds;

    if (triageMode(settings) === 'off' || this.#capabilityFailure() !== null) {
      this.#standDown();
    } else if (triageMode(settings) === 'manual') {
      this.#standDown(this.#automatic);
    }
  }

  /** Start due classifications asynchronously, only while watched to avoid background usage (R35). */
  consider(lanes: readonly Lane[], sourcesRead: boolean, watched: boolean): void {
    // Guard against redraw re-entry before every new task has reserved its concurrency slot.
    if (this.#disposed || this.#considering) {
      return;
    }

    this.#considering = true;

    try {
      const state = nextTriageState(lanes, this.#deps.store.read(), sourcesRead);
      this.#deps.store.write(state);

      if (triageMode(this.#settings) !== 'automatic' || !watched || this.#usageFailed) {
        return;
      }

      const free = this.#settings.concurrency - this.#running.size;

      if (free <= 0) {
        return;
      }

      const waiting = dueForTriage(lanes, state, this.#running, this.#deps.now());

      for (const key of waiting.slice(0, free)) {
        const due = this.#dueOf(lanes, key);

        if (!('kind' in due)) {
          const reserved = this.#usage.reserve(this.#deps.now(), this.#settings.dailyLimit ?? 100);
          if (reserved !== 'reserved') {
            this.#usageFailed = reserved === 'unavailable';
            break;
          }
          this.#automatic.add(key);
          this.#start(due);
        }
      }
    } finally {
      this.#considering = false;
    }
  }

  /**
   * Validate and rate-limit manual card triage requests. A metered request is charged against the rolling
   * daily allowance: the per-card cooldown bounds one card, not a caller working through every key, and a
   * request the developer did not make in their own editor needs a bound on total spend (R33, R38).
   */
  retriage(lanes: readonly Lane[], key: string, metered = false): ReadFailure | null {
    const asked = this.#asked.get(key) ?? 0;
    const now = this.#deps.now();

    if (triageMode(this.#settings) === 'off') {
      return refusal('triage-disabled', 'Card triage is turned off in Settings.');
    }

    const due = this.#dueOf(lanes, key);
    if ('kind' in due) return due;

    if (this.#disposed) {
      return refusal('triage-stopping', 'The board is shutting down.');
    }

    if (this.#running.has(key)) {
      return refusal('triage-running', 'Triage is already running for this card.');
    }

    // Apply concurrency limits to manual requests across all cards.
    if (this.#running.size >= this.#settings.concurrency) {
      return refusal('triage-busy', 'Concurrent triage limit reached. Try again shortly.');
    }

    if (now - asked < RETRIAGE_COOLDOWN_MS) {
      return refusal('triage-too-soon', 'That card was read a moment ago. Try again shortly.');
    }

    if (metered) {
      const reserved = this.#usage.reserve(now, this.#settings.dailyLimit ?? 100);

      if (reserved !== 'reserved') {
        return reserved === 'exhausted'
          ? refusal('triage-limit', 'Triage reached its daily limit. Read this card in VS Code.')
          : refusal('triage-usage', 'Ground Control cannot record triage usage, so it will not start a reading.');
      }
    }

    this.#asked.set(key, now);
    this.#deps.store.write(forgetTriage(this.#deps.store.read(), key));

    // Manual requests run even when no board is watched.
    this.#start(due);

    return null;
  }

  dispose(): void {
    this.#disposed = true;
    this.#standDown();
  }

  /** Mark cancellations before aborting so they do not consume attempts. Timeout aborts remain failures. */
  #standDown(keys?: ReadonlySet<string>): void {
    for (const [key, controller] of this.#inFlight) {
      if (keys !== undefined && !keys.has(key)) continue;
      this.#stoodDown.add(key);
      controller.abort();
    }
  }

  #source(): WorkSource | undefined {
    return this.#deps.sources.find((source) => source.readContext !== undefined && this.#sourceIds.has(source.id));
  }

  #capabilityFailure(): ReadFailure | null {
    if (!this.#deps.agents.some((agent) => agent.classify !== undefined && this.#agentPaths.has(agent.id))) {
      return { ...refusal('triage-no-classifier', 'No enabled agent supports card classification.'), remedy: 'Enable Claude in groundControl.agents to use triage; session discovery remains available.' };
    }
    if (!this.#source()) {
      return { ...refusal('triage-no-source', 'No configured source can provide card conversations.'), remedy: 'Enable and configure a supported source in Settings to use triage.' };
    }
    return null;
  }

  /** Resolve card eligibility independently of classifier and source capability. */
  #dueOf(lanes: readonly Lane[], key: string): Due | ReadFailure {
    const row = lanes.flatMap((lane) => lane.cards).find((card) => card.key === key);
    if (!row) return refusal('triage-unknown-card', 'This card is no longer on the board.');
    if (!row.issue || row.issueNumber === null || row.unassigned || row.lane === 'archived' || key.startsWith('session:')) {
      return refusal('triage-ineligible-card', 'Only assigned issues on active lanes can be classified.');
    }
    const unavailable = this.#capabilityFailure();
    if (unavailable !== null) return unavailable;

    const source = this.#source()!;
    const agent = this.#deps.agents.find((a) => a.classify !== undefined && this.#agentPaths.has(a.id));
    const configured = this.#agentPaths.get(agent!.id)!;
    return { key, card: row.issue, agent: agent!, source, path: configured.path, model: this.#settings.model === undefined ? configured.model : this.#settings.model || null };
  }

  #start(due: Due): void {
    this.#deps.announce('Triaging a card. This uses your Claude allowance and sends issue and pull request text to the model. Set groundControl.triage.mode to off to disable triage.');
    void this.#run(due);
  }

  async #run(due: Due): Promise<void> {
    const controller = new AbortController();
    const sessionId = randomUUID();
    const startedAt = this.#deps.now();

    this.#running.add(due.key);
    this.#inFlight.set(due.key, controller);
    this.#sessions.add(sessionId);
    this.#deps.log.info(`reading ${due.key} with ${due.agent.id}`, 'triage');
    this.#deps.changed();

    // Share one timeout across context retrieval and classification.
    const deadline = setTimeout(() => controller.abort(), this.#settings.timeoutMs);

    try {
      // Record adapter exceptions with retry backoff before broadcasting, or the next broadcast would retry immediately.
      const failure = await this.#read(due, sessionId, controller.signal).catch((error: unknown) => ({
        kind: 'triage-crashed',
        message: error instanceof Error ? error.message : String(error),
      }));

      // Ignore deliberate cancellation; timeout failures still count.
      if (this.#disposed || this.#stoodDown.has(due.key)) {
        this.#deps.log.debug(`${due.key}: triage cancelled`, 'triage');

        return;
      }

      const took = this.#deps.now() - startedAt;

      if (failure === null) {
        this.#deps.log.info(`${due.key} read in ${took}ms`, 'triage');
      } else {
        this.#deps.log.warn(`${due.key} could not be read after ${took}ms: ${failure.kind}`, 'triage');
      }

      const state = this.#deps.store.read();

      this.#deps.store.write(
        failure === null ? state : withTriageFailure(state, due.key, failure, this.#deps.now()),
      );
    } finally {
      clearTimeout(deadline);
      this.#stoodDown.delete(due.key);
      this.#running.delete(due.key);
      this.#automatic.delete(due.key);
      this.#inFlight.delete(due.key);
      this.#sessions.delete(sessionId);
      this.#deps.changed();
    }
  }

  /** Read and classify a card, saving successful results and returning failures without changing lanes. */
  async #read(due: Due, sessionId: string, signal: AbortSignal): Promise<{ kind: string; message: string } | null> {
    const reading = await due.source.readContext!(due.card, signal);

    if (signal.aborted) return { kind: 'triage-cancelled', message: 'Triage was cancelled.' };

    if (reading.context === null) {
      return reading.failure ?? { kind: 'context-empty', message: 'The card conversation could not be read.' };
    }

    // Resolve deterministic actions before classification so the generated detail agrees with the label (R24).
    const settled = settledAction(reading.context, this.#statusLanes);

    const answered = await due.agent.classify!({
      path: due.path,
      sessionId,
      model: due.model,
      systemPrompt: TRIAGE_SYSTEM_PROMPT,
      prompt: buildTriagePrompt(reading.context, this.#deps.now(), settled),
      schema: triageJsonSchema(settled),
      // Run outside project directories to avoid loading repository settings.
      cwd: triageCwd(this.#deps.stateDir),
      timeoutMs: this.#settings.timeoutMs,
      signal,
    });

    if (signal.aborted) return { kind: 'triage-cancelled', message: 'Triage was cancelled.' };

    if ('failure' in answered) {
      return answered.failure;
    }

    const result = readTriageResult(answered.value, settled);

    if (result === null) {
      return { kind: 'triage-unreadable', message: 'Classifier returned an unsupported action.' };
    }

    const { action, qualifier, detail } = resolveTriage(settled, result, reading.context);

    this.#deps.store.write(
      withTriaged(this.#deps.store.read(), due.key, {
        revision: TRIAGE_REVISION,
        action,
        qualifier,
        detail,
        at: this.#deps.now(),
        agent: due.agent.id,
        wasArchived: false,
        evidence: evidenceOf(due.card),
        trigger: triggerOf(due.card),
      }),
    );

    return null;
  }
}

function refusal(kind: string, message: string): ReadFailure {
  return { subject: 'triage', kind, message, remedy: 'Previous triage results are retained.' };
}

/** Run classification in the state directory; a checkout cwd would load repository settings and instructions. */
export function triageCwd(stateDir: string): string {
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch {
    // Let classification report directory-creation failures.
  }

  return stateDir;
}
