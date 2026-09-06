import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { groundControlDirOf } from '@ground-control/core';
import type {
  AgentAdapter,
  IssueCard,
  Lane,
  ReadFailure,
  TriageSettings,
  WorkSource,
} from '@ground-control/core';
import {
  buildTriagePrompt,
  dueForTriage,
  evidenceOf,
  forgetTriage,
  nextTriageState,
  overrideAction,
  readTriageResult,
  triageJsonSchema,
  TRIAGE_SYSTEM_PROMPT,
  withTriageFailure,
  TRIAGE_REVISION,
  withTriaged,
} from '@ground-control/board';
import type { TriageStore } from './triageStore.js';

export interface TriageDeps {
  home: string;
  store: TriageStore;
  /**
   * Says, once per machine, that reading cards spends the developer's usage and sends card text to an API. The
   * activity install — which writes a local file and costs nothing — already announces itself; a feature that
   * spends money and leaves the machine, on by default, cannot say less (R25, R38).
   */
  announce(message: string): void;
  agents: readonly AgentAdapter[];
  sources: readonly WorkSource[];
  now(): number;
  /** Called when a reading lands, so the board redraws. Never called synchronously from `consider`. */
  changed(): void;
}

/** What one card's triage needs to know about the card. `key` is the same key lane placement uses. */
interface Due {
  key: string;
  card: IssueCard;
  agent: AgentAdapter;
  source: WorkSource;
  path: string;
  model: string | null;
}

/**
 * How long the developer must wait before asking for the same card again. A manual re-read is the one message that
 * spends money, so it is rationed rather than taken on trust.
 */
const RETRIAGE_COOLDOWN_MS = 30_000;

/**
 * Reads what each card is asking for, a couple at a time. It owns nothing the snapshot owns: it never places a card,
 * never changes a lane, and its own sessions are filtered out of the roster before the board ever sees them.
 */
export class TriageRunner {
  readonly #deps: TriageDeps;
  readonly #running = new Set<string>();
  readonly #sessions = new Set<string>();
  readonly #inFlight = new Map<string, AbortController>();
  readonly #asked = new Map<string, number>();

  #settings: TriageSettings = { enabled: false, concurrency: 1, timeoutMs: 180_000, names: {} };
  #agentPaths = new Map<string, { path: string; model: string | null }>();
  #disposed = false;
  #considering = false;
  /** Keys the runner stood down itself, so a deliberate abort is never charged to the card as a failure. */
  readonly #stoodDown = new Set<string>();

  constructor(deps: TriageDeps) {
    this.#deps = deps;
  }

  /** The cards being read right now, so the snapshot can say so. */
  running(): ReadonlySet<string> {
    return this.#running;
  }

  /**
   * Why readings could not be made. The snapshot deduplicates these: a card carries nothing when its reading failed,
   * so without them a logged-out CLI would be a board where triage silently never happened (R25).
   */
  failures(): ReadFailure[] {
    return Object.values(this.#deps.store.read().failures).map((failure) => ({
      subject: 'triage',
      kind: failure.kind,
      message: `A card could not be triaged: ${failure.message}`,
      remedy: 'The card keeps whatever reading it had. Click its triage chip to try again.',
    }));
  }

  /**
   * The sessions this runner started. Belt-and-braces: a classification is listed by `claude agents --json` in
   * exactly the shape `neverPrompted` already drops (`docs/mechanics.md` §31), so the adapter filters it first. This
   * is what still holds if a flag ever stops doing what it says.
   */
  sessionIds(): ReadonlySet<string> {
    return this.#sessions;
  }

  /** Takes the settings the hub is running on. Turning triage off stands down what is already in flight. */
  configure(settings: TriageSettings, agents: readonly { id: string; path: string; model?: string | undefined }[]): void {
    this.#settings = settings;
    this.#agentPaths = new Map(agents.map((agent) => [agent.id, { path: agent.path, model: agent.model ?? null }]));

    if (!settings.enabled) {
      this.#standDown();
    }
  }

  /**
   * Starts reading whatever is due. Returns at once — a reading calls back when it lands. Cheap when nothing is due,
   * which is every call but a few: it is a set difference over card keys.
   *
   * `watched` is what keeps an unwatched hub from spending. A window that has activated the extension stays
   * connected with no board open (R35), so without this, opening the editor would read the whole board at nobody.
   */
  consider(lanes: readonly Lane[], sourcesRead: boolean, watched: boolean): void {
    // Starting a reading redraws the board, and redrawing the board is what calls this — so without the guard the
    // first start re-enters here before the second has claimed its slot, and the cap is exceeded by one every time.
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
          `Reading ${waiting.length === 1 ? 'a card' : `${waiting.length} cards`} to work out what each is waiting on. ` +
            `That spends your Claude usage and sends each card's issue and pull request text to the model. ` +
            `Turn it off with groundControl.triage.enabled.`,
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

  /** The developer asking for one card again. Refused for a key no card holds, and rationed. */
  retriage(lanes: readonly Lane[], key: string): ReadFailure | null {
    const due = this.#dueOf(lanes, key);
    const asked = this.#asked.get(key) ?? 0;
    const now = this.#deps.now();

    if (due === null) {
      return refusal('triage-unknown-card', 'That card is not on the board, so there is nothing to read.');
    }

    if (!this.#settings.enabled) {
      return refusal('triage-disabled', 'Card triage is turned off in Settings.');
    }

    if (this.#disposed) {
      return refusal('triage-stopping', 'The board is shutting down.');
    }

    if (this.#running.has(key)) {
      return refusal('triage-running', 'That card is being read now.');
    }

    // The cap is the cap however the reading was asked for. The cooldown is per card, so without this a board of
    // fifteen chips is fifteen clicks away from fifteen classifications at once.
    if (this.#running.size >= this.#settings.concurrency) {
      return refusal('triage-busy', 'The board is already reading as many cards as it may at once. Try again shortly.');
    }

    if (now - asked < RETRIAGE_COOLDOWN_MS) {
      return refusal('triage-too-soon', 'That card was read a moment ago. Try again shortly.');
    }

    this.#asked.set(key, now);
    this.#deps.store.write(forgetTriage(this.#deps.store.read(), key));

    // Asked for by hand, so it runs whether or not a board is watching — the developer clicking is the watching.
    this.#start(due);

    return null;
  }

  dispose(): void {
    this.#disposed = true;
    this.#standDown();
  }

  /**
   * Stops what is in flight. Each key is marked first, because an abort the developer asked for must not land on the
   * card as a failure — charged an attempt, four flicks of the setting would silence a card for good. A timeout
   * aborts the same controller and is not marked, so it is still charged, which is the whole point of the deadline.
   */
  #standDown(): void {
    for (const [key, controller] of this.#inFlight) {
      this.#stoodDown.add(key);
      controller.abort();
    }
  }

  /** The card behind a key, with the agent and source that can read it, or null where anything is missing. */
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

    this.#running.add(due.key);
    this.#inFlight.set(due.key, controller);
    this.#sessions.add(sessionId);
    this.#deps.changed();

    // One budget over the read and the classification together. A hung `gh` and a hung classifier cost the same slot.
    const deadline = setTimeout(() => controller.abort(), this.#settings.timeoutMs);

    try {
      // The seams are public and either may throw rather than classify. A throw that escaped would leave the card
      // with neither an entry nor a failure — which reads as never having been tried, so the next broadcast starts
      // it again with no backoff and no end. Caught here, it is charged and backed off like any other failure, and
      // the record is written before the `finally` below broadcasts.
      const failure = await this.#read(due, sessionId, controller.signal).catch((error: unknown) => ({
        kind: 'triage-crashed',
        message: error instanceof Error ? error.message : String(error),
      }));

      // A run the board stood down itself is not a card that could not be read. A timeout is, and reaches here.
      if (this.#disposed || this.#stoodDown.has(due.key)) {
        return;
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

  /** One card read and classified, or the failure that stopped it. Writes the reading; never writes a lane. */
  async #read(due: Due, sessionId: string, signal: AbortSignal): Promise<{ kind: string; message: string } | null> {
    const reading = await due.source.readContext!(due.card, signal);

    if (reading.context === null) {
      return reading.failure ?? { kind: 'context-empty', message: 'The card conversation could not be read.' };
    }

    const answered = await due.agent.classify!({
      path: due.path,
      sessionId,
      model: due.model,
      systemPrompt: TRIAGE_SYSTEM_PROMPT,
      prompt: buildTriagePrompt(reading.context, this.#deps.now(), this.#settings.names),
      schema: triageJsonSchema,
      // A directory with no project of its own, so nothing of the developer's is discovered or loaded.
      cwd: triageCwd(this.#deps.home),
      timeoutMs: this.#settings.timeoutMs,
      signal,
    });

    if ('failure' in answered) {
      return answered.failure;
    }

    const result = readTriageResult(answered.value);

    if (result === null) {
      return { kind: 'triage-unreadable', message: 'The classifier answered with an action the board does not have.' };
    }

    const { action, qualifier, detail } = overrideAction(result, reading.context);

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
      }),
    );

    return null;
  }
}

function refusal(kind: string, message: string): ReadFailure {
  return { subject: 'triage', kind, message, remedy: 'Nothing to do — the card keeps whatever reading it had.' };
}

/**
 * Where a classification runs. The hub's own directory, created if absent: a `-p` session discovers a project from
 * its working directory, and one started in a checkout would load that repository's settings and instructions.
 */
export function triageCwd(home: string): string {
  const dir = groundControlDirOf(home);

  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // The hub writes here on every pass anyway; a directory it cannot make is a failure the classification reports.
  }

  return dir;
}
