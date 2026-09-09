import { mkdirSync, rmSync } from 'node:fs';
import { ACTION_REVISION, DEFAULT_ACTIONS, fillTemplate, isAutomatable } from '@ground-control/core';
import type { ActionSettings, ActionState, AgentAdapter, AutomatableAction, CardCheckout, Lane, LanedCard, Logger, ReadFailure, Session, WorkSource } from '@ground-control/core';
import {
  actionEnabled,
  alreadyRun,
  cardActionOf,
  dispatchName,
  dispatchesInWindow,
  gateOpen,
  nextActionState,
  planAction,
  promptFor,
  promptValues,
  readActionReport,
  withDispatch,
  withOutcome,
  withRefusal,
  withSession,
} from '@ground-control/automation';
import type { ActionPlan, ActionRefusal } from '@ground-control/automation';
import { read } from './fs.js';
import { actionReportPathOf } from './paths.js';
import type { ActionStore } from './actionStore.js';

export interface ActionDeps {
  home: string;
  store: ActionStore;
  /** Every run the board starts, stops, or settles. This is the board editing the developer's code (R39). */
  log: Logger;
  agents: readonly AgentAdapter[];
  sources: readonly WorkSource[];
  now(): number;
  /**
   * Called when a run starts, lands or is settled, so the board redraws. Redrawing is what calls `consider`, so this
   * re-enters — the `#considering` guard is what makes that safe, and removing it would have the first dispatch
   * start the second before it had claimed its slot.
   */
  changed(): void;
  /**
   * Says, once per machine, that the board has started work on the developer's code. Turning an action on is the
   * consent; the first time one actually fires is the moment worth naming, because it edits a checkout and may push.
   */
  announce(message: string): void;
  /**
   * Answers something the developer asked for by hand. Every gate a hand-asked run reaches is reached after the
   * click has returned, so without this a press that refused would be a press that did nothing and said nothing.
   */
  notify(message: string): void;
}

/** How long a dispatch is given to print the id it minted. `--bg` returns as soon as it has (`mechanics.md` M33). */
const DISPATCH_TIMEOUT_MS = 60_000;

/**
 * The card's checkout, but only where an agent has actually run in it. A folder the developer picked is evidence
 * enough to open a window or start a session they are watching (R41, R42) — not to edit code unattended (R39).
 */
function ranIn(card: LanedCard): CardCheckout | null {
  return card.checkout?.source === 'session' ? card.checkout : null;
}

/**
 * Performs the one card action the board is willing to perform rather than only label (R39). It owns nothing the
 * snapshot owns: it never places a card and never changes a lane. What it does own is a run's outcome, which is the
 * run's own signal — the base branch moves under a card all day, so re-reading GitHub measures the repository
 * rather than the work.
 */
export class ActionRunner {
  readonly #deps: ActionDeps;
  readonly #inFlight = new Map<string, AbortController>();
  /** Keys whose stop is out, so a settle pass does not decide an outcome from underneath it. */
  readonly #settling = new Set<string>();
  /** The shipped settings until a client sends its own, with the daily limit at nothing so no run starts before then. */
  #settings: ActionSettings = { ...DEFAULT_ACTIONS, dailyLimit: 0 };
  #agentPaths = new Map<string, { path: string; model: string | null }>();
  #disposed = false;
  #considering = false;
  /** Why the runner has stood itself down, or null. Set when the store cannot be written — see `#write`. */
  #stalled: string | null = null;

  constructor(deps: ActionDeps) {
    this.#deps = deps;
  }

  configure(settings: ActionSettings, agents: readonly { id: string; path: string; model?: string | undefined }[]): void {
    this.#settings = settings;
    this.#agentPaths = new Map(agents.map((agent) => [agent.id, { path: agent.path, model: agent.model ?? null }]));
  }

  /** The cards being worked on right now, so the snapshot can say so and nothing else is dispatched for them. */
  running(): ReadonlySet<string> {
    return new Set(
      Object.entries(this.#deps.store.read().runs)
        .filter(([, run]) => run.outcome === 'running')
        .map(([key]) => key),
    );
  }

  /**
   * Count persisted running jobs and in-flight dispatches without duplication. Detached dispatch returns
   * before work completes, so counting only starts would allow more concurrent jobs than configured.
   */
  #busy(): number {
    return new Set([...this.#inFlight.keys(), ...this.running()]).size;
  }

  /** Why runs could not be made, deduplicated above the lanes the way every other condition is (R25). */
  failures(): ReadFailure[] {
    const stalled: ReadFailure[] =
      this.#stalled === null
        ? []
        : [
            {
              subject: 'action',
              kind: 'action-stalled',
              message: this.#stalled,
              remedy: 'Check that ~/.claude/ground-control is writable, then reload the window.',
            },
          ];

    return [
      ...stalled,
      ...Object.values(this.#deps.store.read().runs)
        .filter((run) => run.outcome === 'failed')
        .map((run) => ({
          subject: 'action',
          kind: 'action-failed',
          message: `A card action could not be run: ${run.detail}`,
          remedy: "Use the card's action control to retry.",
        })),
    ];
  }

  /**
   * Reconcile tracked runs, then consider automatic starts only while watched and after successful source and
   * roster reads. An initial empty roster is not evidence that a card has no active sessions (R35).
   */
  consider(
    lanes: readonly Lane[],
    sessions: readonly Session[],
    sourcesRead: boolean,
    sessionsRead: boolean,
    watched: boolean,
  ): void {
    if (this.#disposed || this.#considering) {
      return;
    }

    this.#considering = true;

    try {
      // Settled before anything is pruned, because pruning drops what a card no longer on the board left behind and
      // a run in flight is exactly what must not be dropped: forgetting it loses the developer the control that
      // stops the agent still working in their checkout.
      if (sessionsRead) {
        this.#settle(lanes, sessions, sourcesRead);
      }

      this.#write(nextActionState(lanes, this.#deps.store.read(), sourcesRead, this.#deps.now()));

      if (!watched || !sessionsRead || !sourcesRead) {
        return;
      }

      for (const key of this.#due(lanes)) {
        void this.#run(key, lanes, false);
      }
    } finally {
      this.#considering = false;
    }
  }

  /**
   * Stop further dispatches if run-state persistence fails. The same store enforces running-job, retry, and
   * daily limits; ignoring a write failure could repeatedly dispatch unrecorded work. Restart is required
   * after the file becomes writable.
   */
  #write(state: ActionState): void {
    if (this.#deps.store.write(state)) {
      return;
    }

    this.#stalled =
      'The board could not record what it has run, so it has stopped starting work. Nothing is lost — restart the board once the file is writable.';
  }

  /**
   * Manual requests bypass automatic enablement/history while retaining safety checks, concurrency, and
   * positive daily limits. A zero daily limit disables automatic starts only (R32, R39).
   */
  runAction(lanes: readonly Lane[], key: string): ReadFailure | null {
    if (this.#disposed) {
      return refusal('action-stopping', 'The board is shutting down.');
    }

    if (this.#stalled !== null) {
      return refusal('action-stalled', this.#stalled);
    }

    const state = this.#deps.store.read();

    if (state.runs[key]?.outcome === 'running' || this.#inFlight.has(key)) {
      return refusal('action-running', 'A card action is already running.');
    }

    if (this.#busy() >= this.#settings.concurrency) {
      return refusal('action-busy', 'Concurrent card action limit reached.');
    }

    // A ceiling of zero is the board acting on nothing, which is not the developer being refused their own click —
    // that is the one configuration a cautious developer reaches for, and the setting says so in as many words.
    if (this.#settings.dailyLimit > 0 && dispatchesInWindow(state, this.#deps.now()) >= this.#settings.dailyLimit) {
      return refusal('action-daily-limit', 'Card action limit reached for the last 24 hours.');
    }

    void this.#run(key, lanes, true);

    return null;
  }

  /**
   * Taking back a run in flight. Stops the session the board started, and nothing else about the card.
   *
   * The card is marked stopped only where the session actually was: a stop that failed leaves a real agent still
   * working in the developer's checkout, and a card reading "Stopped" over one is the board asserting a state it
   * knows it did not reach (R24). What it says instead is what went wrong, and the run stays stoppable.
   */
  async stopAction(key: string): Promise<ReadFailure | null> {
    const run = this.#deps.store.read().runs[key];

    if (run === undefined || run.outcome !== 'running') {
      return refusal('action-not-running', 'No action is running on this card.');
    }

    this.#inFlight.get(key)?.abort();

    const agent = this.#deps.agents.find((candidate) => candidate.id === run.agent);
    const configured = this.#agentPaths.get(run.agent);

    if (agent?.stopDispatch === undefined || configured === undefined || run.shortId === '') {
      return refusal(
        'action-unstoppable',
        'The board cannot stop that session itself. Stop it from a terminal, or close the tab it is in.',
      );
    }

    // Held while the stop is out, so the settle pass does not decide this run's outcome from underneath it.
    this.#settling.add(key);
    this.#deps.log.info(`${key}: stop requested`, 'actions');

    try {
      // The seam is public and may throw rather than answer. A throw escaping here is an unhandled rejection in the
      // hub, because the client's message is dispatched without one — and the run would be left claiming nothing.
      const failure = await agent
        .stopDispatch(configured.path, run.shortId)
        .catch((error: unknown): ReadFailure => ({
          subject: 'action',
          kind: 'stop-crashed',
          message: `Stopping that session failed: ${error instanceof Error ? error.message : String(error)}`,
          remedy: `Stop the session from a terminal.`,
        }));

      if (failure === null) {
        this.#write(withOutcome(this.#deps.store.read(), key, 'stopped', 'Stopped by you.', this.#deps.now()));
      }

      return failure;
    } finally {
      this.#settling.delete(key);
      this.#deps.changed();
    }
  }

  dispose(): void {
    this.#disposed = true;

    for (const controller of this.#inFlight.values()) {
      controller.abort();
    }
  }

  /**
   * What each card says about its action. Built from the stored run or refusal where there is one, and otherwise
   * from the card's own reading: a card triaged to something the board performs offers the control whether or not
   * the setting is on.
   */
  decorate(lanes: readonly Lane[]): Lane[] {
    const state = this.#deps.store.read();

    return lanes.map((lane) => ({
      ...lane,
      cards: lane.cards.map((card): LanedCard => {
        const action = actionOf(card);
        const decorated = cardActionOf(state, card.key, action, this.#offerRefusal(action, card));

        return decorated === undefined ? card : { ...card, action: decorated };
      }),
    }));
  }

  /** Why a card's control would refuse before it is pressed, where the answer needs no read of GitHub. */
  #offerRefusal(action: AutomatableAction | null, card: LanedCard): string | null {
    if (action === null) {
      return null;
    }

    // Refuse unattended actions while any session is already on the card (R39).
    if (card.sessions.length > 0) {
      return 'This card has an active session.';
    }

    if (ranIn(card) === null) {
      return 'No checkout from a previous session is available for this card.';
    }

    return promptFor(action, this.#settings) === null
      ? `No prompt is set for ${action}. Set groundControl.actions to say what should run.`
      : null;
  }

  /**
   * Select enabled candidate actions with no active run and an expired read gate. Check alreadyRun only after
   * fetching fresh evidence, so a changed head can permit retry after a halted run.
   */
  #due(lanes: readonly Lane[]): string[] {
    const state = this.#deps.store.read();
    const now = this.#deps.now();
    const free = this.#settings.concurrency - this.#busy();

    if (this.#stalled !== null || free <= 0 || dispatchesInWindow(state, now) >= this.#settings.dailyLimit) {
      return [];
    }

    const due: string[] = [];

    for (const lane of lanes) {
      for (const card of lane.cards) {
        const action = actionOf(card);

        if (
          due.length < free &&
          action !== null &&
          actionEnabled(action, this.#settings) &&
          state.runs[card.key]?.outcome !== 'running' &&
          !this.#inFlight.has(card.key) &&
          // Checked before the read rather than in the plan. A card with no checkout can never be acted on, so
          // asking GitHub about it is waste — and the board's history lands after its roster, so a refusal recorded
          // on the pass in between would gate a perfectly eligible card for the whole gate window.
          ranIn(card) !== null &&
          card.sessions.length === 0 &&
          gateOpen(state, card.key, now)
        ) {
          due.push(card.key);
        }
      }
    }

    return due;
  }

  /**
   * Settles runs whose session the roster no longer carries, from the file each was given. A run that says it pushed
   * landed; anything else halted, in the run's own words.
   */
  #settle(lanes: readonly Lane[], sessions: readonly Session[], sourcesRead: boolean): void {
    const state = this.#deps.store.read();
    // `finished` and not merely listed: a `--bg` session stays on the roster after its turn with the CLI's own end
    // word on it, so a run waited on by presence alone would never close (`docs/mechanics.md` M33).
    const live = new Set(sessions.filter((session) => !session.finished).map((session) => session.sessionId));
    const cards = new Map(lanes.flatMap((lane) => lane.cards).map((card) => [card.key, card]));
    let next = state;

    for (const [key, run] of Object.entries(state.runs)) {
      if (run.outcome !== 'running' || this.#settling.has(key)) {
        continue;
      }

      // The full id is resolved from the roster by the short id the CLI printed, because `--bg` will not take one it
      // is given (`docs/mechanics.md` M33). Until that lands the run is open and untouched.
      if (run.sessionId === null) {
        const found = sessions.find((session) => session.sessionId.startsWith(run.shortId) && run.shortId !== '');

        if (found !== undefined) {
          next = withSession(next, key, found.sessionId);
        } else if (this.#deps.now() - run.startedAt > this.#settings.resultTimeoutMs) {
          // A dispatch whose session never appeared is a run the board cannot follow or stop. It waits out the whole
          // budget first, because `--bg` returns before the session registers.
          next = withOutcome(next, key, 'failed', 'The session the board started never appeared on the machine.', this.#deps.now());
        }

        continue;
      }

      if (live.has(run.sessionId)) {
        continue;
      }

      const card = cards.get(key)?.issue;

      if (card == null) {
        // Only a clean source read proves a card has left the board. A failed one renders the last good cards, or
        // none at all on a hub that has just started — and saying a card left when the board could not be read is
        // the wrong sentence on a real run (R24). It stays open until a read settles the question.
        if (sourcesRead) {
          next = withOutcome(next, key, 'halted', 'The card left the board while this was running.', this.#deps.now());
        }

        continue;
      }

      next = this.#settled(next, key);
    }

    if (next !== state) {
      this.#write(next);
      this.#deps.changed();
    }
  }

  /**
   * Settle from the session-written result file without inferring success from current PR state. This is a
   * reported outcome (R39), not the independent stage-completion evidence required by future R23.
   */
  #settled(state: ActionState, key: string): ActionState {
    const report = readActionReport(readJson(actionReportPathOf(this.#deps.home, key)));

    this.#deps.log.info(
      `${key}: the run ${report?.outcome === 'pushed' ? 'landed' : 'ended without landing'}`,
      'actions',
    );

    return withOutcome(
      state,
      key,
      report?.outcome === 'pushed' ? 'landed' : 'halted',
      report?.detail ?? 'The run ended without saying what it did.',
      this.#deps.now(),
    );
  }

  /** One card read afresh, gated, and dispatched — or the refusal that stopped it, recorded so the card can say so. */
  async #run(key: string, lanes: readonly Lane[], asked: boolean): Promise<void> {
    const controller = new AbortController();
    this.#inFlight.set(key, controller);

    try {
      const card = lanes.flatMap((lane) => lane.cards).find((candidate) => candidate.key === key);
      const source = this.#deps.sources.find((candidate) => candidate.readContext !== undefined);
      const agent = this.#deps.agents.find(
        (candidate) => candidate.dispatch !== undefined && this.#agentPaths.has(candidate.id),
      );
      const configured = agent ? this.#agentPaths.get(agent.id) : undefined;

      if (card?.issue == null || source === undefined || agent === undefined || configured === undefined) {
        this.#refuse(key, asked, { kind: 'action-unavailable', message: 'The board cannot act on that card.' });

        return;
      }

      // The action is the card's own reading and never a second look at the same facts: the board derives no merge,
      // so what authorises one is a request somebody wrote. A client may post any key, which is why it is checked
      // here as well as in the control the developer presses.
      const action = actionOf(card);

      if (action === null) {
        this.#refuse(key, asked, { kind: 'not-a-merge', message: 'This card has no merge-upstream action.' });

        return;
      }

      const reading = await source.readContext!(card.issue, controller.signal);

      if (reading.context === null) {
        this.#refuse(key, asked, {
          kind: 'context-empty',
          message: reading.failure?.message ?? 'The card could not be read, so nothing was started.',
        });

        return;
      }

      const decision = planAction({
        action,
        context: reading.context,
        lane: card.lane,
        liveSessions: card.sessions.length,
        checkout: ranIn(card),
        settings: this.#settings,
      });

      if (!decision.ok) {
        this.#refuse(key, asked, decision.refusal);

        return;
      }

      // Checked here rather than in the plan, because it is the one gate a fresh read cannot answer: it is about what
      // the board has already spent, not about what the card is. The developer's own ask is not held to it — that is
      // the retry the rule exists to leave them — and their record is kept rather than deleted, so a run that then
      // refuses leaves the card saying what the last one came to.
      if (!asked && alreadyRun(this.#deps.store.read(), key, decision.plan.evidence)) {
        this.#refuse(key, asked, {
          kind: 'already-run',
          message: 'This action already ran for the card’s current state.',
        });

        return;
      }

      await this.#dispatch(key, decision.plan, agent, configured, controller.signal, asked);
    } catch (error: unknown) {
      // The seams are public and either may throw rather than answer. A throw that escaped would leave the card with
      // no run and no refusal, which reads as never having been tried — and starts it again on the next broadcast.
      this.#refuse(key, asked, {
        kind: 'action-crashed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#inFlight.delete(key);
      this.#deps.changed();
    }
  }

  async #dispatch(
    key: string,
    plan: ActionPlan,
    agent: AgentAdapter,
    configured: { path: string; model: string | null },
    signal: AbortSignal,
    asked: boolean,
  ): Promise<void> {
    const template = promptFor(plan.action, this.#settings);

    if (template === null) {
      this.#refuse(key, asked, {
        kind: 'no-prompt',
        message: `Set a prompt for ${plan.action} before starting it.`,
      });

      return;
    }

    const reportPath = actionReportPathOf(this.#deps.home, key);

    if (!clearReport(reportPath)) {
      this.#refuse(key, asked, {
        kind: 'report-unclearable',
        message: `Could not clear the previous result at ${reportPath}. No new run was started.`,
      });

      return;
    }

    const outcome = await agent.dispatch!({
      path: configured.path,
      prompt: fillTemplate(template, promptValues(plan, reportPath)),
      name: dispatchName(plan),
      cwd: plan.checkout,
      permissionMode: this.#settings.permissionMode,
      model: configured.model,
      timeoutMs: DISPATCH_TIMEOUT_MS,
      signal,
    });

    const now = this.#deps.now();
    const failed = 'failure' in outcome;

    if ('failure' in outcome) {
      this.#deps.log.warn(`${key}: ${plan.action} could not be started: ${outcome.failure.message}`, 'actions');
    } else {
      this.#deps.log.info(`${key}: started ${plan.action} as ${outcome.shortId} in ${plan.checkout}`, 'actions');
    }

    this.#write(
      withDispatch(
        this.#deps.store.read(),
        {
          key,
          action: plan.action,
          revision: ACTION_REVISION,
          evidence: plan.evidence,
          startedAt: now,
          endedAt: failed ? now : null,
          agent: agent.id,
          sessionId: null,
          shortId: failed ? '' : outcome.shortId,
          outcome: failed ? 'failed' : 'running',
          detail: failed ? outcome.failure.message : `Working in ${plan.checkout}.`,
        },
        now,
      ),
    );

    // After the dispatch, not before: a run that never started is not the board having started work on the
    // developer's code, and announcing it would spend the one notice they ever get on something that did not happen.
    if (!failed) {
      this.#deps.announce(
        `Started ${plan.action} for #${plan.issueNumber} in ${plan.checkout}. ` +
          'The agent may edit and push changes. Disable future automatic runs in groundControl.actions.',
      );
    }
  }

  /**
   * Persist automatic refusals and their retry gates. Return manual refusals as notices without closing the
   * next attempt's gate; manual validation completes asynchronously after the click (R25).
   */
  #refuse(key: string, asked: boolean, refused: ActionRefusal): void {
    if (asked) {
      this.#deps.notify(refused.message);

      return;
    }

    this.#write(withRefusal(this.#deps.store.read(), key, refused, this.#deps.now()));
  }
}

/** The action a card is asking for, where that is one the board performs at all. Read once, used everywhere. */
function actionOf(card: LanedCard): AutomatableAction | null {
  const reading = card.triage?.state === 'done' ? card.triage.action : null;

  return reading !== null && isAutomatable(reading) ? reading : null;
}

function refusal(kind: string, message: string): ReadFailure {
  return { subject: 'action', kind, message, remedy: 'Nothing was started, and the card is unchanged.' };
}

function readJson(path: string): unknown {
  const text = read(path);

  if (text === null) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Clears the last run's report, and says whether it could. This is the one file a verdict is read from, so a stale
 * `pushed` left in place would have the next run report a landing it never reached — the reason a dispatch refuses
 * rather than starting a session whose outcome the board could not tell from the previous one's.
 */
function clearReport(path: string): boolean {
  try {
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    rmSync(path, { force: true });

    return true;
  } catch {
    return false;
  }
}
