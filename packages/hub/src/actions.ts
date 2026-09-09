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
  /** Ground Control state directory holding per-card run reports. */
  stateDir: string;
  store: ActionStore;
  /** Log action starts, stops, and outcomes (R39). */
  log: Logger;
  agents: readonly AgentAdapter[];
  sources: readonly WorkSource[];
  now(): number;
  /** Redraw on run changes. Redrawing re-enters consider; #considering prevents duplicate dispatches. */
  changed(): void;
  /** Notify once per machine after the first successful dispatch, which may edit and push changes. */
  announce(message: string): void;
  /** Report asynchronous refusals for manual requests. */
  notify(message: string, kind?: string): void;
  /** Recheck the full roster and current checkout authorization after asynchronous source reads. */
  currentCard?(key: string): LanedCard | undefined;
}

/** Time allowed for the CLI to print its dispatch ID (M33). */
const DISPATCH_TIMEOUT_MS = 60_000;

/** Require a checkout used by a session for unattended edits (R39). User-selected folders allow only manual starts (R41, R42). */
function sessionCheckout(card: LanedCard): CardCheckout | null {
  return card.checkout?.source === 'session' ? card.checkout : null;
}

/** Run supported card actions without changing lane placement. Outcomes come from session reports (R39). */
export class ActionRunner {
  readonly #deps: ActionDeps;
  readonly #inFlight = new Map<string, AbortController>();
  /** Keys with pending stop requests, excluded from outcome checks. */
  readonly #stopping = new Set<string>();
  /** Disable automatic dispatch until a client supplies settings. */
  #settings: ActionSettings = { ...DEFAULT_ACTIONS, dailyLimit: 0 };
  #agentPaths = new Map<string, { path: string; model: string | null }>();
  /** Settings used to authorize pending context reads. Changed settings require a fresh request. */
  #configuration = '';
  #disposed = false;
  #considering = false;
  /** Persistence failure blocking further dispatches; see #write. */
  #persistenceFailure: string | null = null;

  constructor(deps: ActionDeps) {
    this.#deps = deps;
  }

  configure(settings: ActionSettings, agents: readonly { id: string; path: string; model?: string | undefined }[]): void {
    this.#settings = settings;
    this.#agentPaths = new Map(agents.map((agent) => [agent.id, { path: agent.path, model: agent.model ?? null }]));
    this.#configuration = JSON.stringify([settings, agents]);
  }

  /** Card keys with running actions, used for display and duplicate prevention. */
  running(): ReadonlySet<string> {
    return new Set(
      Object.entries(this.#deps.store.read().runs)
        .filter(([, run]) => run.outcome === 'running')
        .map(([key]) => key),
    );
  }

  /** Profile transitions must wait for both launched work and pending dispatch or stop requests. */
  busy(): boolean {
    return this.#inFlight.size > 0 || this.#stopping.size > 0 || this.running().size > 0;
  }

  /**
   * Count persisted running jobs and in-flight dispatches without duplication. Detached dispatch returns
   * before work completes, so counting only starts would allow more concurrent jobs than configured.
   */
  #busy(): number {
    return new Set([...this.#inFlight.keys(), ...this.running()]).size;
  }

  /** Action failures, deduplicated above the lanes (R25). */
  failures(): ReadFailure[] {
    const persistenceFailures: ReadFailure[] =
      this.#persistenceFailure === null
        ? []
        : [
            {
              subject: 'action',
              kind: 'action-stalled',
              message: this.#persistenceFailure,
              remedy: 'Check that ~/.claude/ground-control is writable, then reload the window.',
            },
          ];

    return [
      ...persistenceFailures,
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
      // Resolve outcomes before pruning so active runs retain their stop controls.
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

    this.#persistenceFailure =
      'Could not save action state. New actions are disabled. Restore file access, then reload the window.';
  }

  /**
   * Manual requests bypass automatic enablement/history while retaining safety checks, concurrency, and
   * positive daily limits. A zero daily limit disables automatic starts only (R32, R39).
   */
  runAction(lanes: readonly Lane[], key: string): ReadFailure | null {
    if (this.#disposed) {
      return refusal('action-stopping', 'The board is shutting down.');
    }

    if (this.#persistenceFailure !== null) {
      return refusal('action-stalled', this.#persistenceFailure);
    }

    const state = this.#deps.store.read();

    if (state.runs[key]?.outcome === 'running' || this.#inFlight.has(key)) {
      return refusal('action-running', 'A card action is already running.');
    }

    if (this.#busy() >= this.#settings.concurrency) {
      return refusal('action-busy', 'Concurrent card action limit reached.');
    }

    // Zero disables automatic starts but permits manual requests.
    if (this.#settings.dailyLimit > 0 && dispatchesInWindow(state, this.#deps.now()) >= this.#settings.dailyLimit) {
      return refusal('action-daily-limit', 'Card action limit reached for the last 24 hours.');
    }

    void this.#run(key, lanes, true);

    return null;
  }

  /** Stop the dispatched session. Mark stopped only on success; a failed stop leaves the run stoppable (R24). */
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
        'Cannot stop this session. Stop it from a terminal or close its tab.',
      );
    }

    // Exclude this run from outcome checks while its stop request is pending.
    this.#stopping.add(key);
    this.#deps.log.info(`${key}: stop requested`, 'actions');

    try {
      // Convert adapter rejections to reported failures; this call has no outer rejection handler.
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
      this.#stopping.delete(key);
      this.#deps.changed();
    }
  }

  dispose(): void {
    this.#disposed = true;

    for (const controller of this.#inFlight.values()) {
      controller.abort();
    }
  }

  /** Display stored outcomes and refusals, then available manual actions regardless of automatic enablement. */
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

  /** Report action refusals that require no GitHub read. */
  #offerRefusal(action: AutomatableAction | null, card: LanedCard): string | null {
    if (action === null) {
      return null;
    }

    // Refuse unattended actions while any session is already on the card (R39).
    if (card.sessions.length > 0) {
      return 'This card has an active session.';
    }

    if (sessionCheckout(card) === null) {
      return 'No checkout from a previous session is available for this card.';
    }

    return promptFor(action, this.#settings) === null
      ? `No prompt is set for ${action}. Set its prompt in groundControl.actions.`
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

    if (this.#persistenceFailure !== null || free <= 0 || dispatchesInWindow(state, now) >= this.#settings.dailyLimit) {
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
          // Wait for session history before checking GitHub; an early no-checkout refusal would delay an eligible card.
          sessionCheckout(card) !== null &&
          card.sessions.length === 0 &&
          gateOpen(state, card.key, now)
        ) {
          due.push(card.key);
        }
      }
    }

    return due;
  }

  /** Resolve completed or unlisted sessions from their result files. A reported push means landed; other results mean halted. */
  #settle(lanes: readonly Lane[], sessions: readonly Session[], sourcesRead: boolean): void {
    const state = this.#deps.store.read();
    // Finished background sessions remain listed (M33); presence alone would prevent completion.
    const live = new Set(sessions.filter((session) => !session.finished).map((session) => session.sessionId));
    const cards = new Map(lanes.flatMap((lane) => lane.cards).map((card) => [card.key, card]));
    let next = state;

    for (const [key, run] of Object.entries(state.runs)) {
      if (run.outcome !== 'running' || this.#stopping.has(key)) {
        continue;
      }

      // Resolve the full session ID from the returned prefix; Claude --bg does not accept a caller-supplied ID (M33).
      if (run.sessionId === null) {
        const found = sessions.find((session) => session.sessionId.startsWith(run.shortId) && run.shortId !== '');

        if (found !== undefined) {
          next = withSession(next, key, found.sessionId);
        } else if (this.#deps.now() - run.startedAt > this.#settings.resultTimeoutMs) {
          // Allow registration time before declaring the dispatched session missing (M33).
          next = withOutcome(next, key, 'failed', 'The dispatched session was not found before the timeout.', this.#deps.now());
        }

        continue;
      }

      if (live.has(run.sessionId)) {
        continue;
      }

      const card = cards.get(key)?.issue;

      if (card == null) {
        // Require a successful source read to confirm the card left the board (R24).
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
    const report = readActionReport(readJson(actionReportPathOf(this.#deps.stateDir, key)));

    this.#deps.log.info(
      `${key}: ${report?.outcome === 'pushed' ? 'push reported' : 'no push reported'}`,
      'actions',
    );

    return withOutcome(
      state,
      key,
      report?.outcome === 'pushed' ? 'landed' : 'halted',
      report?.detail ?? 'The run ended without a readable result.',
      this.#deps.now(),
    );
  }

  /** Read fresh context, validate, then dispatch or record the refusal. */
  async #run(key: string, lanes: readonly Lane[], asked: boolean): Promise<void> {
    const controller = new AbortController();
    this.#inFlight.set(key, controller);

    try {
      const configuration = this.#configuration;
      let card = lanes.flatMap((lane) => lane.cards).find((candidate) => candidate.key === key);
      const source = this.#deps.sources.find((candidate) => candidate.readContext !== undefined);
      const selected = this.#settings.agent ?? 'auto';
      const agent = this.#deps.agents.find(
        (candidate) => candidate.dispatch !== undefined && this.#agentPaths.has(candidate.id) && (selected === 'auto' || candidate.id === selected),
      );
      const configured = agent ? this.#agentPaths.get(agent.id) : undefined;

      if (card?.issue == null || source === undefined) {
        this.#refuse(key, asked, { kind: 'action-unavailable', message: 'The board cannot act on that card.' });

        return;
      }

      if (agent === undefined || configured === undefined) {
        this.#refuse(key, asked, {
          kind: 'action-agent-unavailable',
          message: selected === 'auto'
            ? 'No enabled agent supports card actions. Enable a supported agent in groundControl.agents.'
            : `The selected action agent "${selected}" is not enabled or cannot dispatch. Enable it in groundControl.agents or change groundControl.actions.agent.`,
        });

        return;
      }

      if (!agent.dispatchPermissions?.includes(this.#settings.permissionMode)) {
        this.#refuse(key, asked, {
          kind: 'action-permission-unsupported',
          message: `${agent.displayName} cannot use "${this.#settings.permissionMode}" for card actions. Set groundControl.actions.permissionMode to a supported mode (${agent.dispatchPermissions?.join(', ') || 'none declared'}) or change groundControl.actions.agent.`,
        });

        return;
      }

      // Require the card's requested action on the server too; clients can submit arbitrary card keys.
      const action = actionOf(card);

      if (action === null) {
        this.#refuse(key, asked, { kind: 'not-a-merge', message: 'This card has no merge-upstream action.' });

        return;
      }

      const reading = await source.readContext!(card.issue, controller.signal);

      if (this.#deps.currentCard) card = this.#deps.currentCard(key);
      if (controller.signal.aborted || card === undefined) {
        this.#refuse(key, asked, { kind: 'action-unavailable', message: 'This card is no longer available. Nothing was started.' });
        return;
      }

      if (configuration !== this.#configuration) {
        this.#refuse(key, asked, { kind: 'action-settings-changed', message: 'Action settings changed while reading the card. Retry with the current settings.' });

        return;
      }

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
        checkout: sessionCheckout(card),
        settings: this.#settings,
      });

      if (!decision.ok) {
        this.#refuse(key, asked, decision.refusal);

        return;
      }

      // Check persisted runs separately from fresh context. Manual retries bypass this check and retain the previous outcome.
      if (!asked && alreadyRun(this.#deps.store.read(), key, decision.plan.evidence)) {
        this.#refuse(key, asked, {
          kind: 'already-run',
          message: 'This action already ran for the card’s current state.',
        });

        return;
      }

      await this.#dispatch(key, decision.plan, agent, configured, controller.signal, asked);
    } catch (error: unknown) {
      // Record adapter exceptions as refusals so subsequent broadcasts respect retry limits.
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

    const reportPath = actionReportPathOf(this.#deps.stateDir, key);

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
      model: this.#settings.model === undefined ? configured.model : this.#settings.model || null,
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

    // Announce only successful starts so a failed dispatch does not consume the one-time notice.
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
      this.#deps.notify(refused.message, refused.kind);

      return;
    }

    this.#write(withRefusal(this.#deps.store.read(), key, refused, this.#deps.now()));
  }
}

/** Return the supported action from completed triage. */
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

/** Remove the previous report before dispatch. A stale pushed result could falsely complete a new run. */
function clearReport(path: string): boolean {
  try {
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    rmSync(path, { force: true });

    return true;
  } catch {
    return false;
  }
}
