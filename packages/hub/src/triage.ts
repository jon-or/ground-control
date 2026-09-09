import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { groundControlDirOf } from '@ground-control/core';
import type { AgentAdapter, IssueCard, Lane, LaneId, Logger, ReadFailure, TriageSettings, WorkSource } from '@ground-control/core';
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

export interface TriageDeps {
  home: string;
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

  #settings: TriageSettings = { enabled: false, concurrency: 1, timeoutMs: 180_000, names: {} };
  /** Use the same status mapping as lane assignment (R38). */
  #statusLanes: Readonly<Record<string, LaneId>> = {};
  #agentPaths = new Map<string, { path: string; model: string | null }>();
  #disposed = false;
  #considering = false;
  /** Deliberately cancelled keys do not count as failed attempts. */
  readonly #stoodDown = new Set<string>();

  constructor(deps: TriageDeps) {
    this.#deps = deps;
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
      remedy: 'Previous triage results are retained. Use the card’s triage retry control in VS Code.',
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
  ): void {
    this.#settings = settings;
    this.#statusLanes = statusLanes;
    this.#agentPaths = new Map(agents.map((agent) => [agent.id, { path: agent.path, model: agent.model ?? null }]));

    if (!settings.enabled) {
      this.#standDown();
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

      if (!this.#settings.enabled || !watched) {
        return;
      }

      const free = this.#settings.concurrency - this.#running.size;

      if (free <= 0) {
        return;
      }

      const waiting = dueForTriage(lanes, state, this.#running, this.#deps.now());

      if (waiting.length > 0) {
        this.#deps.announce(
          `Triaging ${waiting.length === 1 ? 'a card' : `${waiting.length} cards`}. ` +
            `This uses your Claude allowance and sends issue and pull request text to the model. ` +
            `Disable triage with groundControl.triage.enabled.`,
        );
      }

      for (const key of waiting.slice(0, free)) {
        const due = this.#dueOf(lanes, key);

        if (due !== null) {
          this.#start(due);
        }
      }
    } finally {
      this.#considering = false;
    }
  }

  /** Validate and rate-limit manual card triage requests. */
  retriage(lanes: readonly Lane[], key: string): ReadFailure | null {
    const due = this.#dueOf(lanes, key);
    const asked = this.#asked.get(key) ?? 0;
    const now = this.#deps.now();

    if (due === null) {
      return refusal('triage-unknown-card', 'This card is no longer on the board.');
    }

    if (!this.#settings.enabled) {
      return refusal('triage-disabled', 'Card triage is turned off in Settings.');
    }

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
  #standDown(): void {
    for (const [key, controller] of this.#inFlight) {
      this.#stoodDown.add(key);
      controller.abort();
    }
  }

  /** Resolve the card, agent, and source, or return null if any is unavailable. */
  #dueOf(lanes: readonly Lane[], key: string): Due | null {
    const card = lanes.flatMap((lane) => lane.cards).find((c) => c.key === key)?.issue;

    if (!card) {
      return null;
    }

    const source = this.#deps.sources.find((s) => s.readContext !== undefined);
    const agent = this.#deps.agents.find((a) => a.classify !== undefined && this.#agentPaths.has(a.id));
    const configured = agent ? this.#agentPaths.get(agent.id) : undefined;

    return source && agent && configured
      ? { key, card, agent, source, path: configured.path, model: configured.model }
      : null;
  }

  #start(due: Due): void {
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
      this.#inFlight.delete(due.key);
      this.#sessions.delete(sessionId);
      this.#deps.changed();
    }
  }

  /** Read and classify a card, saving successful results and returning failures without changing lanes. */
  async #read(due: Due, sessionId: string, signal: AbortSignal): Promise<{ kind: string; message: string } | null> {
    const reading = await due.source.readContext!(due.card, signal);

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
      prompt: buildTriagePrompt(reading.context, this.#deps.now(), this.#settings.names, settled),
      schema: triageJsonSchema(settled),
      // Run outside project directories to avoid loading repository settings.
      cwd: triageCwd(this.#deps.home),
      timeoutMs: this.#settings.timeoutMs,
      signal,
    });

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

/** Run classification in the hub directory; a checkout cwd would load repository settings and instructions. */
export function triageCwd(home: string): string {
  const dir = groundControlDirOf(home);

  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Let classification report directory-creation failures.
  }

  return dir;
}
