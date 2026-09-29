import { mkdirSync, rmSync } from 'node:fs';
import { ACTION_REVISION, CREATE_WORKTREE, DEFAULT_ACTIONS, DEFAULT_WORKTREE, isAutomatable, repositoryKey, rowFor } from '@ground-control/core';
import type {
  ActionRow,
  ActionSettings,
  ActionState,
  AgentAdapter,
  AutomatableAction,
  CardAction,
  Clone,
  Lane,
  LanedCard,
  Logger,
  ReadFailure,
  Session,
  TriageContext,
  TriageQualifier,
  WorkSource,
  WorktreeCreation,
  WorktreeSettings,
} from '@ground-control/core';
import {
  actionEnabled,
  actionPrompt,
  alreadyRun,
  cardActionOf,
  dispatchName,
  dispatchesInWindow,
  gateOpen,
  isDeveloperLogin,
  nextActionState,
  planAction,
  promptFor,
  promptValues,
  readActionReport,
  sessionLinks,
  withDispatch,
  withOutcome,
  withRefusal,
  withSession,
  withoutAbsentLinks,
  worktreeCreationOf,
  worktreePrompt,
  worktreePromptValues,
} from '@ground-control/automation';
import type { ActionPlan, ActionRefusal, CardReading, WorktreePullRequest } from '@ground-control/automation';
import { triageable, triageLabel } from '@ground-control/board';
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

/** An action table row as a reading names it. */
interface Row {
  action: AutomatableAction;
  qualifier: TriageQualifier | null;
}

/** How a run was asked for: by a click, by the automatic check, or as the action after its worktree run. */
interface Request {
  asked: boolean;
  /** The worktree run already counted any automatic request against the daily limit and cleared its record. */
  chained: boolean;
  /** For a chained request, the row the worktree run was started for; a reading that moved since starts nothing. */
  row?: Row;
  /** For a chained request, the worktree run's session, whose work is reported and so is not other work on the card. */
  after?: string;
}

/**
 * A request being read and dispatched, before its run record exists. `shown` names the control that says it is
 * starting: set for a click and for the action after its worktree run, not for an automatic check that may refuse.
 */
interface InFlight {
  controller: AbortController;
  since: number;
  shown: 'action' | 'worktree' | null;
}

/** Run supported card actions without changing lane placement. Outcomes come from session reports (R39). */
export class ActionRunner {
  readonly #deps: ActionDeps;
  readonly #inFlight = new Map<string, InFlight>();
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

  /** The issue each dispatched session belongs to, by `agent:sessionId` (R3). */
  links(): ReadonlyMap<string, number> {
    return sessionLinks(this.#deps.store.read());
  }

  /**
   * Forget links to sessions absent from complete roster and history reads, by `agent:sessionId`. A link of an agent
   * that was not read, such as one turned off for now, is kept: its absence says nothing about the session.
   */
  pruneLinks(present: ReadonlySet<string>, readAgents: ReadonlySet<string>): void {
    const state = this.#deps.store.read();
    const unread = Object.keys(state.links).filter((key) => !readAgents.has(key.slice(0, key.indexOf(':'))));
    const next = withoutAbsentLinks(state, new Set([...present, ...unread]), this.#deps.now());

    if (next !== state) {
      this.#write(next);
    }
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
   * Manual requests bypass automatic enablement, history, the retry gate, and the daily limit, which they do not
   * spend, while retaining safety checks and concurrency (R32, R39).
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

    const card = lanes.flatMap((lane) => lane.cards).find((candidate) => candidate.key === key);

    if (worktreeOnly) {
      void this.#runWorktree(key, card, { asked: true, chained: false });
    } else {
      void this.#run(key, card, { asked: true, chained: false });
    }

    // Show the click as starting now; reading the card and dispatching take seconds before a run record exists. A
    // request refused before its first await has already broadcast.
    if (this.#inFlight.has(key)) {
      this.#deps.changed();
    }

    return null;
  }

  /** Stop the dispatched session. Mark stopped only on success; a failed stop leaves the run stoppable (R24). */
  async stopAction(key: string): Promise<ReadFailure | null> {
    const run = this.#deps.store.read().runs[key];

    if (run === undefined || run.outcome !== 'running') {
      return refusal('action-not-running', 'No action is running on this card.');
    }

    this.#inFlight.get(key)?.controller.abort();

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

    for (const { controller } of this.#inFlight.values()) {
      controller.abort();
    }
  }

  /**
   * Display a request still starting, stored outcomes and refusals, then available manual actions regardless of
   * automatic enablement, and the worktree control's state on a card that has none (R46).
   */
  decorate(lanes: readonly Lane[]): Lane[] {
    const state = this.#deps.store.read();
    const clones = this.#deps.clones();

    return lanes.map((lane) => ({
      ...lane,
      cards: lane.cards.map((card): LanedCard => {
        const reading = readingOf(card, this.#settings.table);
        const starting = this.#inFlight.get(card.key);
        const decorated: CardAction | undefined = starting?.shown === 'action' && reading.action !== null
          ? { state: 'running', action: reading.action, qualifier: reading.qualifier, since: starting.since, stage: 'starting' }
          : cardActionOf(state, card.key, reading, this.#offerRefusal(reading, card, clones));
        // An action on a card with no worktree starts with the worktree run, so that control starts too (R46).
        const creation: WorktreeCreation | undefined = !this.#creatable(card)
          ? undefined
          : starting !== undefined && starting.shown !== null
            ? { state: 'running', since: starting.since, stage: 'starting' }
            : worktreeCreationOf(state, card.key, this.#worktreeRefusal(card, clones));

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
  #offerRefusal(reading: CardReading, card: LanedCard, clones: readonly Clone[]): string | null {
    const { action, qualifier } = reading;

    if (action === null) {
      return null;
    }

    // Refuse unattended actions while any session is still running on the card (R39).
    if (activeSessions(card) > 0) {
      return 'This card has an active session.';
    }

    if (card.worktree === undefined) {
      const refused = hasIssue(card) ? this.#worktreeRefusal(card, clones) : 'This card has no issue to make a worktree for.';

      if (refused !== null) {
        return refused;
      }
    }

    const row = rowFor(this.#settings.table, action, qualifier);

    if (row === undefined && action === 'merge') {
      const target = card.triage?.state === 'done' ? card.triage.target : null;

      return target === null
        ? 'Triage could not tell which kind of merge this is. Read the card again.'
        : `The request names ${target}, which is neither this pull request's branch, its base, nor a test branch. Read the card again.`;
    }

    return promptFor(row) === null ? `No prompt is set for ${triageLabel(action, qualifier)}. Set it in the action table.` : null;
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
        const { action, qualifier } = readingOf(card, this.#settings.table);

        if (
          due.length < free &&
          action !== null &&
          actionEnabled(rowFor(this.#settings.table, action, qualifier)) &&
          state.runs[card.key]?.outcome !== 'running' &&
          !this.#inFlight.has(card.key) &&
          // Wait for a worktree, or the means to make one, before checking GitHub; an early refusal would delay an eligible card.
          (card.worktree !== undefined || (hasIssue(card) && this.#worktreeRefusal(card, clones) === null)) &&
          activeSessions(card) === 0 &&
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
    const continued: { key: string; row: Row; after: string }[] = [];
    let next = state;

    for (const [key, run] of Object.entries(state.runs)) {
      if (run.outcome !== 'running' || this.#stopping.has(key)) {
        continue;
      }

      // Resolve the full session ID from the returned prefix; Claude --bg does not accept a caller-supplied ID (M33).
      if (run.sessionId === null) {
        const found = sessions.find((session) => session.sessionId.startsWith(run.shortId) && run.shortId !== '');

        if (found !== undefined) {
          next = withSession(next, key, found.sessionId, this.#deps.now());
        } else if (this.#deps.now() - run.startedAt > this.#settings.resultTimeoutMs) {
          // Allow registration time before declaring the dispatched session missing (M33).
          next = withOutcome(next, key, 'failed', 'The dispatched session was not found before the timeout.', this.#deps.now());
        }

        continue;
      }

      // A run that ends on a question stays listed as blocked, not finished (M33); its written result settles it.
      if (live.has(run.sessionId) && readActionReport(readJson(actionReportPathOf(this.#deps.stateDir, key))) === null) {
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
          continued.push({ key, row: { action: run.next, qualifier: run.qualifier }, after: run.sessionId });
        }
      } else {
        next = this.#settled(next, key);
      }
    }

    if (next !== state) {
      this.#write(next);
    }

    // The action the worktree run preceded starts now, in the worktree the card carries after the write above.
    for (const { key, row, after } of continued) {
      void this.#run(key, this.#deps.currentCard?.(key), { asked: false, chained: true, row, after });
    }

    // After the chained starts, so the card shows them starting; the next broadcast may be a roster poll away.
    if (next !== state) {
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
      `${key}: ${landed(report) ? 'completion reported' : 'no completion reported'}`,
      'actions',
    );

    return withOutcome(
      state,
      key,
      landed(report) ? 'landed' : 'halted',
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
    this.#inFlight.set(key, { controller, since: this.#deps.now(), shown: request.asked || request.chained ? 'action' : null });
    // Known once the reading is; a crash after that is a refusal of this row.
    let row: Row | null = null;

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

      // Require the card's requested row on the server too; clients can submit arbitrary card keys.
      const cardReading = readingOf(card, this.#settings.table);
      const { action, qualifier } = cardReading;

      if (action === null) {
        this.#refuse(key, request, { kind: 'no-action', message: 'This card has no action to run.' });

        return;
      }

      row = { action, qualifier };

      // The click or the automatic check that started the worktree run consented to its row, not to whatever the card
      // reads as now.
      if (request.row !== undefined && (request.row.action !== action || request.row.qualifier !== qualifier)) {
        this.#refuse(key, request, {
          kind: 'reading-changed',
          message: `The card now reads as ${triageLabel(action, qualifier)}, not the ${triageLabel(request.row.action, request.row.qualifier)} its worktree was made for. Nothing was started.`,
        }, row);

        return;
      }
      const target = card.triage?.state === 'done' ? card.triage.target : null;
      const reading = await source.readContext!(card.issue, controller.signal);

      if (this.#deps.currentCard) card = this.#deps.currentCard(key);
      if (controller.signal.aborted || card === undefined) {
        this.#refuse(key, request, { kind: 'action-unavailable', message: 'This card is no longer available. Nothing was started.' }, row);
        return;
      }

      if (configuration !== this.#configuration) {
        this.#refuse(key, request, { kind: 'action-settings-changed', message: 'Action settings changed while reading the card. Retry with the current settings.' }, row);

        return;
      }

      if (reading.context === null) {
        this.#refuse(key, request, {
          kind: 'context-empty',
          message: reading.failure?.message ?? 'The card could not be read, so nothing was started.',
        }, row);

        return;
      }

      const decision = planAction({
        action,
        qualifier,
        target,
        context: reading.context,
        lane: card.lane,
        liveSessions: activeSessions(card, request.after),
        testBranchPattern: this.#settings.testBranchPattern,
      });

      if (!decision.ok) {
        this.#refuse(key, request, decision.refusal, row);

        return;
      }

      // Check persisted runs separately from fresh context. Manual retries bypass this check and retain the
      // previous outcome; a chained run follows its own worktree run's record.
      if (!request.asked && !request.chained && alreadyRun(this.#deps.store.read(), key, decision.plan.evidence, action, statusChangedAt(card))) {
        this.#refuse(key, request, {
          kind: 'already-run',
          message: 'This action already ran for the card’s current state.',
        }, row);

        return;
      }

      // The action needs a worktree to work in (R46). Without one, the worktree run goes first and this action after.
      if (card.worktree === undefined) {
        if (!hasIssue(card)) {
          this.#refuse(key, request, { kind: 'action-unavailable', message: 'This card is no longer available. Nothing was started.' }, row);
        } else {
          const pullRequest = { number: decision.plan.pullRequest, branch: decision.plan.branch, role: decision.plan.role };

          await this.#dispatchWorktree(key, card, row, pullRequest, agent, controller.signal, request);
        }

        return;
      }

      await this.#dispatch(key, decision.plan, card.worktree.root, agent, controller.signal, request);
    } catch (error: unknown) {
      // Record adapter exceptions as refusals so subsequent broadcasts respect retry limits.
      this.#refuse(key, request, {
        kind: 'action-crashed',
        message: error instanceof Error ? error.message : String(error),
      }, row);
    } finally {
      this.#inFlight.delete(key);
      this.#deps.changed();
    }
  }

  /**
   * A worktree run asked for on its own (R46). A card with a pull request is read first, because a reviewer's
   * worktree checks out its head.
   */
  async #runWorktree(key: string, card: LanedCard | undefined, request: Request): Promise<void> {
    const controller = new AbortController();
    this.#inFlight.set(key, { controller, since: this.#deps.now(), shown: request.asked ? 'worktree' : null });

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

      let pullRequest: WorktreePullRequest | null = null;

      if (card.issue.pullRequest != null) {
        const configuration = this.#configuration;
        const source = this.#deps.sources.find((candidate) => candidate.readContext !== undefined);
        const reading = source === undefined ? null : await source.readContext!(card.issue, controller.signal);

        // The card can gain a worktree, or the settings change, while it is read; recheck as `#run` does.
        if (this.#deps.currentCard) card = this.#deps.currentCard(key);
        if (controller.signal.aborted || card === undefined || !this.#creatable(card)) {
          this.#refuse(key, request, { kind: 'worktree-unavailable', message: 'This card is no longer available. Nothing was started.' });

          return;
        }

        if (configuration !== this.#configuration) {
          this.#refuse(key, request, { kind: 'action-settings-changed', message: 'Action settings changed while reading the card. Retry with the current settings.' });

          return;
        }

        if (reading?.context == null) {
          this.#refuse(key, request, {
            kind: 'context-empty',
            message: reading?.failure?.message ?? 'The card’s pull request could not be read, so no worktree was started.',
          });

          return;
        }

        pullRequest = pullRequestOf(reading.context);
      }

      await this.#dispatchWorktree(key, card, undefined, pullRequest, agent, controller.signal, request);
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
    const row: Row = { action: plan.action, qualifier: plan.qualifier };
    const label = triageLabel(plan.action, plan.qualifier);
    const template = promptFor(rowFor(this.#settings.table, plan.action, plan.qualifier));

    if (template === null) {
      this.#refuse(key, request, {
        kind: 'no-prompt',
        message: `Set a prompt for ${label} in the action table before starting it.`,
      }, row);

      return;
    }

    const reportPath = actionReportPathOf(this.#deps.stateDir, key);

    if (!clearReport(reportPath)) {
      this.#refuse(key, request, {
        kind: 'report-unclearable',
        message: `Could not clear the previous result at ${reportPath}. No new run was started.`,
      }, row);

      return;
    }

    const outcome = await agent.dispatch!({
      path: configured.path,
      prompt: actionPrompt(template, promptValues(plan, checkout, reportPath)),
      name: dispatchName(plan.action, plan.issueNumber, plan.qualifier),
      cwd: checkout,
      permissionMode: this.#settings.permissionMode,
      model: this.#settings.model === undefined ? configured.model : this.#settings.model || null,
      timeoutMs: DISPATCH_TIMEOUT_MS,
      signal,
    });

    const now = this.#deps.now();
    const failed = 'failure' in outcome;

    if ('failure' in outcome) {
      this.#deps.log.warn(`${key}: ${label} could not be started: ${outcome.failure.message}`, 'actions');
    } else {
      this.#deps.log.info(`${key}: started ${label} as ${outcome.shortId} in ${checkout}`, 'actions');
    }

    this.#write(
      withDispatch(
        this.#deps.store.read(),
        {
          key,
          action: plan.action,
          qualifier: plan.qualifier,
          issueNumber: plan.issueNumber,
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
        !request.asked && !request.chained,
      ),
    );

    // Announce only successful starts so a failed dispatch does not consume the one-time notice.
    if (!failed) {
      this.#deps.announce(
        `Started ${label} for #${plan.issueNumber} in ${checkout}. ` +
          'The agent may edit and push changes. Turn off automatic runs in the action table.',
      );
    }
  }

  /**
   * Start the worktree prompt in the card's clone (R46). `next` is the row that follows once the run reports the
   * worktree; the record carries it so settling knows what to start.
   */
  async #dispatchWorktree(
    key: string,
    card: IssueCard,
    next: Row | undefined,
    pullRequest: WorktreePullRequest | null,
    { agent, configured }: { agent: AgentAdapter; configured: { path: string; model: string | null } },
    signal: AbortSignal,
    request: Request,
  ): Promise<void> {
    const template = this.#worktree.prompt.trim();

    if (template === '') {
      this.#refuse(key, request, {
        kind: 'no-worktree',
        message: 'No worktree for this issue. Set groundControl.worktree.prompt so one can be created.',
      }, next ?? null);

      return;
    }

    const clone = cloneFor(card, this.#deps.clones());

    if ('refusal' in clone) {
      this.#refuse(key, request, { kind: 'no-clone', message: clone.refusal }, next ?? null);

      return;
    }

    const reportPath = actionReportPathOf(this.#deps.stateDir, key);

    if (!clearReport(reportPath)) {
      this.#refuse(key, request, {
        kind: 'report-unclearable',
        message: `Could not clear the previous result at ${reportPath}. No new run was started.`,
      }, next ?? null);

      return;
    }

    const outcome = await agent.dispatch!({
      path: configured.path,
      prompt: worktreePrompt(template, worktreePromptValues(card, clone.cwd, reportPath, pullRequest)),
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
      const then = next === undefined ? '' : `, then ${triageLabel(next.action, next.qualifier)}`;

      this.#deps.log.info(`${key}: started ${CREATE_WORKTREE} as ${outcome.shortId} in ${clone.cwd}${then}`, 'actions');
    }

    this.#write(
      withDispatch(
        this.#deps.store.read(),
        {
          key,
          action: CREATE_WORKTREE,
          ...(next === undefined ? {} : { next: next.action }),
          qualifier: next?.qualifier ?? null,
          issueNumber: card.issueNumber,
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
        !request.asked,
      ),
    );

    if (!failed) {
      this.#deps.announce(
        `Started a worktree run for #${card.issueNumber} in ${clone.cwd}. ` +
          'The agent may create branches and directories. Turn off automatic runs in the action table.',
      );
    }
  }

  /**
   * Persist automatic refusals, of the row where one was known, and their retry gates. Return manual refusals as
   * notices without closing the next attempt's gate; manual validation completes asynchronously after the click (R25).
   */
  #refuse(key: string, request: Request, refused: ActionRefusal, row: Row | null = null): void {
    if (request.asked) {
      this.#deps.notify(refused.message, refused.kind);

      return;
    }

    this.#write(withRefusal(this.#deps.store.read(), key, refused, this.#deps.now(), row));
  }
}

/** Whether the run reported its work complete: `done`, or `pushed`, which merge prompts written before `done` use. */
function landed(report: ReturnType<typeof readActionReport>): boolean {
  return report?.outcome === 'done' || report?.outcome === 'pushed';
}

/** When the card's status last changed, the new request a landed run waits for (R39). */
function statusChangedAt(card: LanedCard): number | null {
  const at = card.issue?.statusChangedAt ? Date.parse(card.issue.statusChangedAt) : NaN;

  return Number.isFinite(at) ? at : null;
}

/** Sessions still running on the card. A finished background session stays listed (M33) but is not active work. */
function activeSessions(card: LanedCard, except?: string): number {
  return card.sessions.filter((session) => !session.finished && session.sessionId !== except).length;
}

/** The card's pull request as a worktree run needs it (R46). */
function pullRequestOf(context: TriageContext): WorktreePullRequest | null {
  const pr = context.pullRequest;

  if (pr === null) {
    return null;
  }

  return { number: pr.number, branch: pr.headRefName, role: isDeveloperLogin(pr.author, context.logins) ? 'author' : 'reviewer' };
}

/**
 * The card's reading, where the action table has a row for it. A card the board does not read carries none and
 * never will, so its reading is settled; one being read again, or whose read failed, is not, and keeps the outcome
 * the card already shows.
 */
export function readingOf(card: LanedCard, table: readonly ActionRow[]): CardReading {
  const triage = card.triage;

  if (triage?.state === 'done') {
    const { action, qualifier } = triage;
    // A merge triage could not type still has the table's merge rows as candidates, so the card says why it cannot run.
    const untyped = action === 'merge' && qualifier === null && table.some((row) => row.action === 'merge');
    const found = isAutomatable(action) && (rowFor(table, action, qualifier) !== undefined || untyped);

    return found ? { action, qualifier, settled: true, at: triage.at } : { action: null, qualifier: null, settled: true, at: triage.at };
  }

  return { action: null, qualifier: null, settled: triage === undefined && !triageable(card), at: null };
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
