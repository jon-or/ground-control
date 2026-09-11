import { mkdirSync, rmSync } from 'node:fs';
import { ACTION_REVISION, CREATE_WORKTREE, DEFAULT_ACTIONS, DEFAULT_WORKTREE, fillTemplate, isAutomatable, repositoryKey } from '@ground-control/core';
import type { ActionSettings, ActionState, AgentAdapter, AutomatableAction, Clone, Lane, LanedCard, Logger, ReadFailure, Session, WorkSource, WorktreeSettings } from '@ground-control/core';
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
  worktreeCreationOf,
  worktreePromptValues,
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
  /** The clones the hub knows, where a worktree run starts (R46). */
  clones(): readonly Clone[];
  /** Record the worktree a run reported for the card once git registers it in the card's repository; else why not. */
  linkWorktree(key: string, root: string): string | null;
}

/** Time allowed for the CLI to print its dispatch ID (M33). */
const DISPATCH_TIMEOUT_MS = 60_000;

/** A card with an issue, which a worktree run needs to name the branch after. */
type IssueCard = LanedCard & { issueNumber: number; issue: NonNullable<LanedCard['issue']> };

function hasIssue(card: LanedCard): card is IssueCard {
  return card.issue !== null && card.issueNumber !== null;
}

/** How a run was asked for: by a click, by the automatic check, or as the action after its worktree run. */
interface Request {
  asked: boolean;
  /** The worktree run already counted this request against the daily limit and cleared its record. */
  chained: boolean;
}

/** Run supported card actions without changing lane placement. Outcomes come from session reports (R39). */
export class ActionRunner {
  readonly #deps: ActionDeps;
  readonly #inFlight = new Map<string, AbortController>();
  /** Keys with pending stop requests, excluded from outcome checks. */
  readonly #stopping = new Set<string>();
  /** Disable automatic dispatch until a client supplies settings. */
  #settings: ActionSettings = { ...DEFAULT_ACTIONS, dailyLimit: 0 };
  #worktree: WorktreeSettings = DEFAULT_WORKTREE;
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

  configure(settings: ActionSettings, agents: readonly { id: string; path: string; model?: string | undefined }[], worktree: WorktreeSettings): void {
    this.#settings = settings;
    this.#worktree = worktree;
    this.#agentPaths = new Map(agents.map((agent) => [agent.id, { path: agent.path, model: agent.model ?? null }]));
    this.#configuration = JSON.stringify([settings, agents, worktree]);
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

      for (const card of this.#due(lanes)) {
        void this.#run(card.key, card, { asked: false, chained: false });
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
    return this.#request(lanes, key, false);
  }

  /** Make the card's worktree without an action after it (R46). Bounded like a manual action: it is one. */
  createWorktree(lanes: readonly Lane[], key: string): ReadFailure | null {
    return this.#request(lanes, key, true);
  }

  #request(lanes: readonly Lane[], key: string, worktreeOnly: boolean): ReadFailure | null {
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

    const card = lanes.flatMap((lane) => lane.cards).find((candidate) => candidate.key === key);

    if (worktreeOnly) {
      void this.#runWorktree(key, card, { asked: true, chained: false });
    } else {
      void this.#run(key, card, { asked: true, chained: false });
    }

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

  /**
   * Display stored outcomes and refusals, then available manual actions regardless of automatic enablement, and
   * the worktree control's state on a card that has none (R46).
   */
  decorate(lanes: readonly Lane[]): Lane[] {
    const state = this.#deps.store.read();
    const clones = this.#deps.clones();

    return lanes.map((lane) => ({
      ...lane,
      cards: lane.cards.map((card): LanedCard => {
        const action = actionOf(card);
        const decorated = cardActionOf(state, card.key, action, this.#offerRefusal(action, card, clones));
        const creation = this.#creatable(card) ? worktreeCreationOf(state, card.key, this.#worktreeRefusal(card, clones)) : undefined;

        return {
          ...card,
          ...(decorated === undefined ? {} : { action: decorated }),
          ...(creation === undefined ? {} : { creation }),
        };
      }),
    }));
  }

  /** Creating needs an issue to name the branch after; archived and unassigned cards are read-only (R9). */
  #creatable(card: LanedCard): card is IssueCard {
    return hasIssue(card) && card.worktree === undefined && card.unassigned !== true && card.lane !== 'archived';
  }

  /** Report action refusals that require no GitHub read. */
  #offerRefusal(action: AutomatableAction | null, card: LanedCard, clones: readonly Clone[]): string | null {
    if (action === null) {
      return null;
    }

    // Refuse unattended actions while any session is already on the card (R39).
    if (card.sessions.length > 0) {
      return 'This card has an active session.';
    }

    if (card.worktree === undefined) {
      const refused = hasIssue(card) ? this.#worktreeRefusal(card, clones) : 'This card has no issue to make a worktree for.';

      if (refused !== null) {
        return refused;
      }
    }

    return promptFor(action, this.#settings) === null
      ? `No prompt is set for ${action}. Set its prompt in groundControl.actions.`
      : null;
  }

  /** Why no worktree run can start for the card: no prompt, or no single clone of its repository (R46). */
  #worktreeRefusal(card: IssueCard, clones: readonly Clone[]): string | null {
    if (this.#worktree.prompt.trim() === '') {
      return 'No worktree for this issue. Set groundControl.worktree.prompt so one can be created.';
    }

    const found = cloneFor(card, clones);

    return 'refusal' in found ? found.refusal : null;
  }

  /**
   * Select enabled candidate actions with no active run and an expired read gate. Check alreadyRun only after
   * fetching fresh evidence, so a changed head can permit retry after a halted run.
   */
  #due(lanes: readonly Lane[]): LanedCard[] {
    const state = this.#deps.store.read();
    const now = this.#deps.now();
    const free = this.#settings.concurrency - this.#busy();

    if (this.#persistenceFailure !== null || free <= 0 || dispatchesInWindow(state, now) >= this.#settings.dailyLimit) {
      return [];
    }

    const clones = this.#deps.clones();
    const due: LanedCard[] = [];

    for (const lane of lanes) {
      for (const card of lane.cards) {
        const action = actionOf(card);

        if (
          due.length < free &&
          action !== null &&
          actionEnabled(action, this.#settings) &&
          state.runs[card.key]?.outcome !== 'running' &&
          !this.#inFlight.has(card.key) &&
          // Wait for a worktree, or the means to make one, before checking GitHub; an early refusal would delay an eligible card.
          (card.worktree !== undefined || (hasIssue(card) && this.#worktreeRefusal(card, clones) === null)) &&
          card.sessions.length === 0 &&
          gateOpen(state, card.key, now)
        ) {
          due.push(card);
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
    const continued: string[] = [];
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

      if (run.action === CREATE_WORKTREE) {
        const made = this.#settledWorktree(next, key);

        next = made.state;

        if (made.linked && run.next !== undefined) {
          continued.push(key);
        }
      } else {
        next = this.#settled(next, key);
      }
    }

    if (next !== state) {
      this.#write(next);
      this.#deps.changed();
    }

    // The action the worktree run preceded starts now, in the worktree the card carries after the write above.
    for (const key of continued) {
      void this.#run(key, this.#deps.currentCard?.(key), { asked: false, chained: true });
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

  /**
   * Settle a worktree run from its result file (R46). Landed means the reported path is now the card's
   * worktree; a path git does not register, or one outside scope, halts the run with the reason.
   */
  #settledWorktree(state: ActionState, key: string): { state: ActionState; linked: boolean } {
    const report = readActionReport(readJson(actionReportPathOf(this.#deps.stateDir, key)));
    const now = this.#deps.now();

    if (report?.outcome !== 'ready' || report.worktree === undefined) {
      this.#deps.log.info(`${key}: no worktree reported`, 'actions');
      const detail = report?.outcome === 'halted' ? report.detail : 'The run ended without reporting a worktree.';

      return { state: withOutcome(state, key, 'halted', detail, now), linked: false };
    }

    const refused = this.#deps.linkWorktree(key, report.worktree);

    if (refused !== null) {
      this.#deps.log.warn(`${key}: reported worktree ${report.worktree} not linked: ${refused}`, 'actions');

      return { state: withOutcome(state, key, 'halted', refused, now), linked: false };
    }

    this.#deps.log.info(`${key}: worktree ${report.worktree} reported`, 'actions');

    return { state: withOutcome(state, key, 'landed', `Created ${report.worktree}. ${report.detail}`, now), linked: true };
  }

  /** Read fresh context, validate, then dispatch or record the refusal. */
  async #run(key: string, card: LanedCard | undefined, request: Request): Promise<void> {
    const controller = new AbortController();
    this.#inFlight.set(key, controller);

    try {
      const configuration = this.#configuration;
      const source = this.#deps.sources.find((candidate) => candidate.readContext !== undefined);
      const agent = this.#agent();

      if (card?.issue == null || source === undefined) {
        this.#refuse(key, request, { kind: 'action-unavailable', message: 'The board cannot act on that card.' });

        return;
      }

      if ('refusal' in agent) {
        this.#refuse(key, request, agent.refusal);

        return;
      }

      // Require the card's requested action on the server too; clients can submit arbitrary card keys.
      const action = actionOf(card);

      if (action === null) {
        this.#refuse(key, request, { kind: 'not-a-merge', message: 'This card has no merge-upstream action.' });

        return;
      }

      const reading = await source.readContext!(card.issue, controller.signal);

      if (this.#deps.currentCard) card = this.#deps.currentCard(key);
      if (controller.signal.aborted || card === undefined) {
        this.#refuse(key, request, { kind: 'action-unavailable', message: 'This card is no longer available. Nothing was started.' });
        return;
      }

      if (configuration !== this.#configuration) {
        this.#refuse(key, request, { kind: 'action-settings-changed', message: 'Action settings changed while reading the card. Retry with the current settings.' });

        return;
      }

      if (reading.context === null) {
        this.#refuse(key, request, {
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
        settings: this.#settings,
      });

      if (!decision.ok) {
        this.#refuse(key, request, decision.refusal);

        return;
      }

      // Check persisted runs separately from fresh context. Manual retries bypass this check and retain the
      // previous outcome; a chained run follows its own worktree run's record.
      if (!request.asked && !request.chained && alreadyRun(this.#deps.store.read(), key, decision.plan.evidence)) {
        this.#refuse(key, request, {
          kind: 'already-run',
          message: 'This action already ran for the card’s current state.',
        });

        return;
      }

      // The action needs a worktree to work in (R46). Without one, the worktree run goes first and this action after.
      if (card.worktree === undefined) {
        if (!hasIssue(card)) {
          this.#refuse(key, request, { kind: 'action-unavailable', message: 'This card is no longer available. Nothing was started.' });
        } else {
          await this.#dispatchWorktree(key, card, action, agent, controller.signal, request);
        }

        return;
      }

      await this.#dispatch(key, decision.plan, card.worktree.root, agent, controller.signal, request);
    } catch (error: unknown) {
      // Record adapter exceptions as refusals so subsequent broadcasts respect retry limits.
      this.#refuse(key, request, {
        kind: 'action-crashed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#inFlight.delete(key);
      this.#deps.changed();
    }
  }

  /** A worktree run asked for on its own (R46): no context read, since the run's prompt reads what it needs. */
  async #runWorktree(key: string, card: LanedCard | undefined, request: Request): Promise<void> {
    const controller = new AbortController();
    this.#inFlight.set(key, controller);

    try {
      const agent = this.#agent();

      if (card === undefined || !this.#creatable(card)) {
        this.#refuse(key, request, { kind: 'worktree-unavailable', message: 'The board cannot make a worktree for that card.' });

        return;
      }

      if ('refusal' in agent) {
        this.#refuse(key, request, agent.refusal);

        return;
      }

      await this.#dispatchWorktree(key, card, undefined, agent, controller.signal, request);
    } catch (error: unknown) {
      this.#refuse(key, request, {
        kind: 'action-crashed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#inFlight.delete(key);
      this.#deps.changed();
    }
  }

  /** The dispatching agent the settings select, checked for a permission mode it accepts. */
  #agent(): { agent: AgentAdapter; configured: { path: string; model: string | null } } | { refusal: ActionRefusal } {
    const selected = this.#settings.agent ?? 'auto';
    const agent = this.#deps.agents.find(
      (candidate) => candidate.dispatch !== undefined && this.#agentPaths.has(candidate.id) && (selected === 'auto' || candidate.id === selected),
    );
    const configured = agent ? this.#agentPaths.get(agent.id) : undefined;

    if (agent === undefined || configured === undefined) {
      return {
        refusal: {
          kind: 'action-agent-unavailable',
          message: selected === 'auto'
            ? 'No enabled agent supports card actions. Enable a supported agent in groundControl.agents.'
            : `The selected action agent "${selected}" is not enabled or cannot dispatch. Enable it in groundControl.agents or change groundControl.actions.agent.`,
        },
      };
    }

    if (!agent.dispatchPermissions?.includes(this.#settings.permissionMode)) {
      return {
        refusal: {
          kind: 'action-permission-unsupported',
          message: `${agent.displayName} cannot use "${this.#settings.permissionMode}" for card actions. Set groundControl.actions.permissionMode to a supported mode (${agent.dispatchPermissions?.join(', ') || 'none declared'}) or change groundControl.actions.agent.`,
        },
      };
    }

    return { agent, configured };
  }

  async #dispatch(
    key: string,
    plan: ActionPlan,
    checkout: string,
    { agent, configured }: { agent: AgentAdapter; configured: { path: string; model: string | null } },
    signal: AbortSignal,
    request: Request,
  ): Promise<void> {
    const template = promptFor(plan.action, this.#settings);

    if (template === null) {
      this.#refuse(key, request, {
        kind: 'no-prompt',
        message: `Set a prompt for ${plan.action} before starting it.`,
      });

      return;
    }

    const reportPath = actionReportPathOf(this.#deps.stateDir, key);

    if (!clearReport(reportPath)) {
      this.#refuse(key, request, {
        kind: 'report-unclearable',
        message: `Could not clear the previous result at ${reportPath}. No new run was started.`,
      });

      return;
    }

    const outcome = await agent.dispatch!({
      path: configured.path,
      prompt: fillTemplate(template, promptValues(plan, checkout, reportPath)),
      name: dispatchName(plan.action, plan.issueNumber),
      cwd: checkout,
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
      this.#deps.log.info(`${key}: started ${plan.action} as ${outcome.shortId} in ${checkout}`, 'actions');
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
          detail: failed ? outcome.failure.message : `Working in ${checkout}.`,
        },
        now,
        !request.chained,
      ),
    );

    // Announce only successful starts so a failed dispatch does not consume the one-time notice.
    if (!failed) {
      this.#deps.announce(
        `Started ${plan.action} for #${plan.issueNumber} in ${checkout}. ` +
          'The agent may edit and push changes. Disable future automatic runs in groundControl.actions.',
      );
    }
  }

  /**
   * Start the worktree prompt in the card's clone (R46). `next` is the action that follows once the run reports
   * the worktree; the record carries it so settling knows what to start.
   */
  async #dispatchWorktree(
    key: string,
    card: IssueCard,
    next: AutomatableAction | undefined,
    { agent, configured }: { agent: AgentAdapter; configured: { path: string; model: string | null } },
    signal: AbortSignal,
    request: Request,
  ): Promise<void> {
    const template = this.#worktree.prompt.trim();

    if (template === '') {
      this.#refuse(key, request, {
        kind: 'no-worktree',
        message: 'No worktree for this issue. Set groundControl.worktree.prompt so one can be created.',
      });

      return;
    }

    const clone = cloneFor(card, this.#deps.clones());

    if ('refusal' in clone) {
      this.#refuse(key, request, { kind: 'no-clone', message: clone.refusal });

      return;
    }

    const reportPath = actionReportPathOf(this.#deps.stateDir, key);

    if (!clearReport(reportPath)) {
      this.#refuse(key, request, {
        kind: 'report-unclearable',
        message: `Could not clear the previous result at ${reportPath}. No new run was started.`,
      });

      return;
    }

    const outcome = await agent.dispatch!({
      path: configured.path,
      prompt: fillTemplate(template, worktreePromptValues(card, clone.cwd, reportPath)),
      name: dispatchName(CREATE_WORKTREE, card.issueNumber),
      cwd: clone.cwd,
      permissionMode: this.#settings.permissionMode,
      model: this.#settings.model === undefined ? configured.model : this.#settings.model || null,
      timeoutMs: DISPATCH_TIMEOUT_MS,
      signal,
    });

    const now = this.#deps.now();
    const failed = 'failure' in outcome;

    if ('failure' in outcome) {
      this.#deps.log.warn(`${key}: ${CREATE_WORKTREE} could not be started: ${outcome.failure.message}`, 'actions');
    } else {
      this.#deps.log.info(`${key}: started ${CREATE_WORKTREE} as ${outcome.shortId} in ${clone.cwd}${next === undefined ? '' : `, then ${next}`}`, 'actions');
    }

    this.#write(
      withDispatch(
        this.#deps.store.read(),
        {
          key,
          action: CREATE_WORKTREE,
          ...(next === undefined ? {} : { next }),
          revision: ACTION_REVISION,
          // A worktree run has no PR head to key on; the action after it reads its own fresh evidence.
          evidence: '',
          startedAt: now,
          endedAt: failed ? now : null,
          agent: agent.id,
          sessionId: null,
          shortId: failed ? '' : outcome.shortId,
          outcome: failed ? 'failed' : 'running',
          detail: failed ? outcome.failure.message : `Creating a worktree from ${clone.cwd}.`,
        },
        now,
      ),
    );

    if (!failed) {
      this.#deps.announce(
        `Started a worktree run for #${card.issueNumber} in ${clone.cwd}. ` +
          'The agent may create branches and directories. Disable future automatic runs in groundControl.actions.',
      );
    }
  }

  /**
   * Persist automatic refusals and their retry gates. Return manual refusals as notices without closing the
   * next attempt's gate; manual validation completes asynchronously after the click (R25).
   */
  #refuse(key: string, request: Request, refused: ActionRefusal): void {
    if (request.asked) {
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

/**
 * The one clone of the card's repository a worktree run starts in: its main working tree, or its git directory
 * where it has none. Several clones need the developer to narrow the list (R46).
 */
function cloneFor(card: IssueCard, clones: readonly Clone[]): { cwd: string } | { refusal: string } {
  const wanted = repositoryKey(card.issue.url);
  const named = card.issue.repository ?? wanted;
  const found = clones.filter((clone) => clone.repository === wanted);
  const [clone] = found;

  if (clone === undefined) {
    return { refusal: `Ground Control has no clone of ${named}. Open one in an editor window, or add it to groundControl.repositoryRoots.` };
  }

  if (found.length > 1) {
    return { refusal: `Ground Control knows ${found.length} clones of ${named} and cannot choose between them. Narrow groundControl.repositoryRoots.` };
  }

  return { cwd: clone.root ?? clone.commonDir };
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
