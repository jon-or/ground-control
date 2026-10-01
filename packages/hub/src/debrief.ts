import { DEBRIEF_ENV, DEFAULT_DEBRIEF, frictionAnswer, isAbsolute, join, normalize } from '@ground-control/core';
import type { AgentAdapter, AgentConfig, DebriefRange, DebriefSettings, DebriefSignal, HistoricalSession, Logger, MachineReaders, Session, TextOutcome } from '@ground-control/core';
import type { CodexDebriefState, DebriefLogEntry, DebriefState, DebriefStore, SessionDebriefState } from './debriefStore.js';

/** A session is debriefed this long after its last finished turn (R52). */
export const DEBRIEF_IDLE_MS = 45 * 60 * 1000;

/** Past this age the one-hour prompt cache has expired; the session is skipped rather than run cold. */
export const DEBRIEF_EXPIRY_MS = 60 * 60 * 1000;

/** Work since the last debrief needs at least this many main-transcript tool calls. */
export const DEBRIEF_TOOL_CALL_FLOOR = 10;

/** Failed attempts on one range, or on one Codex thread, before it waits for new work. */
export const DEBRIEF_ATTEMPT_LIMIT = 3;

/** Wait after a failed attempt before the next. */
export const DEBRIEF_RETRY_MS = 5 * 60 * 1000;

/** One fork, or one Codex debrief command, runs at most this long; a fork waits on the subagents it asks. */
export const DEBRIEF_TIMEOUT_MS = 10 * 60 * 1000;

/** How often the hub scans for idle sessions. */
export const DEBRIEF_SCAN_MS = 60 * 1000;

const CLAUDE = 'claude';

/** Exit code of the Codex debrief command for a session that is not a Codex thread, or with `--since`, has no turn since. */
const NOT_CODEX_EXIT = 3;

export interface DebriefSessions {
  live: readonly Session[];
  history: readonly HistoricalSession[];
  /** Agents whose roster or history read failed; their idle sessions cannot be told apart from absent ones. */
  unreadable: ReadonlySet<string>;
}

export interface DebriefDeps {
  now(): number;
  log: Logger;
  home: string;
  readers(): MachineReaders;
  agents: readonly AgentAdapter[];
  /** A roster and history no older than a scan, or null when none can be read. */
  sessions(): Promise<DebriefSessions | null>;
  store(dir: string): DebriefStore;
  /** Run the Codex debrief script for one thread with `DEBRIEF_ENV` set. */
  runCodex(script: string, threadId: string, promptPath: string, since: string | null, timeoutMs: number, signal: AbortSignal): Promise<TextOutcome>;
  newId(): string;
}

interface Candidate {
  sessionId: string;
  cwd: string;
  /** Last finished turn: the Stop marker for a live session, the transcript write for a closed one. */
  lastAt: number;
}

/** The settings one scan uses throughout, so a change mid-scan cannot mix two configurations. */
interface ScanSettings {
  generation: number;
  claudePath: string;
  dir: string;
  promptPath: string;
  prompt: string;
  codexScript: string;
  store: DebriefStore;
  signal: DebriefSignal;
}

/** A configured path: empty takes the default, and `~` or a relative path is under the home directory. */
export function underHome(value: string, home: string, fallback: string): string {
  const path = normalize(value);

  if (path === '') return join(home, fallback);
  if (path.startsWith('~/')) return join(home, path.slice(2));

  return isAbsolute(path) ? path : join(home, path);
}

/**
 * Choose the sessions in the debrief window now, oldest first, so the one nearest cache expiry runs first. Whether one
 * has work since its last debrief is the range read's decision, since a turn can finish while its debrief runs.
 */
export function dueSessions(sessions: DebriefSessions, state: DebriefState, now: number): Candidate[] {
  const live = new Set(sessions.live.filter((session) => session.agent === CLAUDE).map((session) => session.sessionId));
  const candidates: Candidate[] = [];

  for (const session of sessions.live) {
    // A live `--bg` job refuses a resume while its process holds the session (M33).
    if (session.agent !== CLAUDE || (session.details['kind'] === 'background' && session.pid !== null)) continue;

    const activity = session.activity;

    // Without a Stop marker the hub cannot tell a long tool call from a finished turn.
    if (activity?.event !== 'Stop' || (activity.backgroundTasks ?? 0) > 0) continue;

    candidates.push({ sessionId: session.sessionId, cwd: session.cwd, lastAt: activity.at });
  }

  for (const session of sessions.history) {
    if (session.agent !== CLAUDE || live.has(session.sessionId)) continue;

    candidates.push({ sessionId: session.sessionId, cwd: session.cwd, lastAt: session.updatedAt });
  }

  return candidates
    .filter((candidate) => {
      const age = now - candidate.lastAt;
      const attemptedAt = state.sessions[candidate.sessionId]?.attemptedAt;

      return age >= DEBRIEF_IDLE_MS && age < DEBRIEF_EXPIRY_MS && (!attemptedAt || now - Date.parse(attemptedAt) >= DEBRIEF_RETRY_MS);
    })
    .sort((left, right) => left.lastAt - right.lastAt);
}

/**
 * Fill the prompt's `{{scope}}`. The fork sees messages, not uuids, so a repeat debrief names the message its range
 * starts at by its opening text.
 */
export function promptFor(template: string, range: DebriefRange): string {
  const scope = range.fromPrompt === null ? 'the whole conversation' : `the work after the user message that begins "${range.fromPrompt}"`;

  // A function replacement keeps `$&` and the like in the quoted message literal.
  return template.replaceAll('{{scope}}', () => scope);
}

/** Whether a range read for a due session is worth a fork. */
export function rangeDue(range: DebriefRange, held: SessionDebriefState | undefined): boolean {
  if (range.throughMessageUuid === held?.throughMessageUuid || range.toolCalls < DEBRIEF_TOOL_CALL_FLOOR) return false;

  return !(held !== undefined && held.attemptedThrough === range.throughMessageUuid && held.attempts >= DEBRIEF_ATTEMPT_LIMIT);
}

/** Whether a Codex thread is waiting for the command, and its retry delay has passed. */
function codexDue(held: CodexDebriefState, now: number): boolean {
  return held.pending && (held.attemptedAt === null || now - Date.parse(held.attemptedAt) >= DEBRIEF_RETRY_MS);
}

/**
 * Debrief finished Claude sessions (R52): fork each idle session once its work passes the floor, and append what the
 * fork reports to the log. The only writer of the debrief state and log.
 */
export class DebriefRunner {
  readonly #deps: DebriefDeps;
  #settings: DebriefSettings = { ...DEFAULT_DEBRIEF };
  #claudePath = CLAUDE;
  #claudeEnabled = false;
  /** Bumped by every configuration, so a scan stops starting work once its settings are stale. */
  #generation = 0;
  #scanning = false;
  readonly #forks = new Set<string>();
  readonly #abort = new AbortController();
  /** Range reads keyed by session, reused while its transcript is unchanged. */
  readonly #ranges = new Map<string, { writtenAt: number; from: string | null; range: DebriefRange | null }>();
  /** The last condition logged, so a scan repeating it every minute says it once. */
  #said = '';
  /**
   * Log lines and state a write could not store. No model call starts until they are stored, so a failed write can
   * neither discard a paid answer, repeat paid work, nor reset a retry count.
   */
  #unsaved: { dir: string; lines: DebriefLogEntry[]; state: DebriefState } | null = null;

  constructor(deps: DebriefDeps) {
    this.#deps = deps;
  }

  configure(settings: DebriefSettings, agents: readonly AgentConfig[]): void {
    this.#settings = settings;
    const claude = agents.find((agent) => agent.id === CLAUDE);
    this.#claudeEnabled = claude !== undefined;
    this.#claudePath = claude?.path || CLAUDE;
    this.#generation++;
  }

  /** Forks now running, which the roster read must drop. */
  sessionIds(): ReadonlySet<string> {
    return this.#forks;
  }

  dispose(): void {
    this.#abort.abort();
  }

  #say(condition: string, message: string, level: 'debug' | 'warn' = 'debug'): void {
    if (condition === this.#said) return;
    this.#said = condition;
    this.#deps.log[level](message, 'debrief');
  }

  /** Whether work may still start under the settings a scan began with. */
  #current(scan: ScanSettings): boolean {
    return !this.#abort.signal.aborted && this.#settings.enabled && this.#generation === scan.generation && this.#unsaved === null;
  }

  /** Run every due debrief, one fork at a time, then the Codex threads waiting to be asked. A scan in progress absorbs the call. */
  async scan(): Promise<void> {
    if (this.#scanning || !this.#settings.enabled || this.#abort.signal.aborted) return;

    this.#scanning = true;

    try {
      await this.#scan();
    } finally {
      this.#scanning = false;
    }
  }

  #prepare(): ScanSettings | null {
    const signal = this.#deps.agents.find((candidate) => candidate.id === CLAUDE)?.debrief;

    if (!this.#claudeEnabled || signal === undefined) {
      this.#say('no-claude', 'Claude is not enabled, so no session is debriefed.');
      return null;
    }

    const home = this.#deps.home;
    const dir = underHome(this.#settings.directory, home, '.claude/.wip/debrief');
    const promptPath = underHome(this.#settings.promptPath, home, '.claude/skills/friction-review/prompt.md');
    const prompt = this.#deps.readers().readText(promptPath);

    if (prompt === null || prompt.trim() === '') {
      this.#say('no-prompt', `No debrief prompt at ${promptPath}, so no session is debriefed.`);
      return null;
    }

    return {
      generation: this.#generation,
      claudePath: this.#claudePath,
      dir,
      promptPath,
      prompt,
      codexScript: underHome(this.#settings.codexScript, home, '.claude/tools/agent-delegate/debrief.mjs'),
      store: this.#deps.store(dir),
      signal,
    };
  }

  async #scan(): Promise<void> {
    const scan = this.#prepare();

    if (scan === null) return;

    const stored = this.#stored(scan);

    if (stored === null) return;

    let state = this.#reconciled(scan, stored);

    if (state === null) return;

    // Threads left waiting by an earlier scan go first, so a thread held by a failed write still follows its parent's line.
    state = await this.#askCodex(scan, state);
    const tried = new Set<string>();

    // Read the roster again before each fork: an earlier fork can take minutes, in which a session may resume.
    while (this.#current(scan)) {
      const sessions = await this.#deps.sessions();

      if (sessions === null || sessions.unreadable.has(CLAUDE)) {
        this.#say('no-roster', 'The Claude session list could not be read, so no session is debriefed.');
        break;
      }

      this.#said = '';
      const next = this.#next(scan, sessions, state, tried);

      if (next === null || !this.#current(scan)) break;

      tried.add(next.candidate.sessionId);
      state = await this.#debrief(scan, state, next.candidate, next.range);
      state = await this.#askCodex(scan, state);
    }
  }

  /**
   * The state to scan with: one a write could not store, once it is stored, else the file's. What a write could not
   * store goes to the directory it came from, even after the setting moved, so a held answer is not lost.
   */
  #stored(scan: ScanSettings): DebriefState | null {
    const unsaved = this.#unsaved;

    if (unsaved !== null) {
      this.#unsaved = DebriefRunner.#persist(unsaved.dir === scan.dir ? scan.store : this.#deps.store(unsaved.dir), unsaved.dir, unsaved.state, unsaved.lines);

      if (this.#unsaved !== null) {
        this.#say('unsaved', `${DebriefRunner.#unwritten(this.#unsaved)} cannot be written; debriefs wait until it can.`, 'warn');
        return null;
      }

      if (unsaved.dir === scan.dir) return unsaved.state;
    }

    const state = scan.store.readState();

    if (state === null) this.#say('bad-state', `${scan.dir}/state.json cannot be read; debriefs wait until it can.`, 'warn');

    return state;
  }

  #next(scan: ScanSettings, sessions: DebriefSessions, state: DebriefState, tried: ReadonlySet<string>): { candidate: Candidate; range: DebriefRange } | null {
    const readers = this.#deps.readers();

    for (const candidate of dueSessions(sessions, state, this.#deps.now())) {
      if (tried.has(candidate.sessionId)) continue;

      const range = this.#range(scan.signal, readers, candidate, state.sessions[candidate.sessionId]?.throughMessageUuid ?? null);

      if (range !== null && rangeDue(range, state.sessions[candidate.sessionId])) return { candidate, range };
    }

    return null;
  }

  #range(signal: DebriefSignal, readers: MachineReaders, candidate: Candidate, from: string | null): DebriefRange | null {
    const writtenAt = signal.transcriptWrittenAt(readers, candidate);

    if (writtenAt === null) return null;

    const cached = this.#ranges.get(candidate.sessionId);

    if (cached?.writtenAt === writtenAt && cached.from === from) return cached.range;

    const range = signal.readRange(readers, candidate, from);
    this.#ranges.set(candidate.sessionId, { writtenAt, from, range });

    return range;
  }

  /**
   * Bring the state up to the log. A hub that stopped between appending a line and storing the state leaves the log
   * ahead: a Claude line becomes its session's last debrief whether or not the session is still in its window, and a
   * Codex line moves its thread's `--since` past it. A log that cannot be read stops the scan.
   */
  #reconciled(scan: ScanSettings, state: DebriefState): DebriefState | null {
    const logged = scan.store.logged();

    if ('unreadable' in logged) {
      this.#say('bad-log', `${scan.dir}/log cannot be read, so what was debriefed is unknown; debriefs wait until it can.`, 'warn');
      return null;
    }

    let next = state;

    for (const [sessionId, line] of logged.claude) {
      const held = next.sessions[sessionId];

      if (held?.debriefedAt && line.at <= held.debriefedAt) continue;

      this.#deps.log.info(`${sessionId} is in the debrief log through ${line.throughMessageUuid}; recording it`, 'debrief');
      next = DebriefRunner.#shown(DebriefRunner.#covered(next, sessionId, line.cwd, line.throughMessageUuid, line.delegated, line.at), sessionId, line.subagents, line.startedAt);
    }

    for (const [thread, line] of logged.codex) {
      const held = next.codex[thread];

      if (held === undefined || (held.debriefedAt !== null && line.at <= held.debriefedAt)) continue;

      next = { ...next, codex: { ...next.codex, [thread]: { ...held, debriefedAt: line.at } } };
    }

    return next === state ? state : this.#save(scan, next);
  }

  /** A successful debrief through `through`: the session's record moves past it, and its Codex threads wait to be asked. */
  static #covered(state: DebriefState, sessionId: string, cwd: string, through: string | null, delegated: readonly string[], at: string): DebriefState {
    const codex = { ...state.codex };

    for (const thread of delegated) {
      const held = codex[thread];

      // A thread the command said is not Codex's has neither a debrief nor an error.
      if (held !== undefined && !held.pending && held.debriefedAt === null && held.lastError === null) continue;

      codex[thread] = { parentSessionId: sessionId, cwd, debriefedAt: held?.debriefedAt ?? null, lastError: held?.lastError ?? null, pending: true, attempts: 0, attemptedAt: null };
    }

    return {
      ...state,
      sessions: {
        ...state.sessions,
        [sessionId]: { throughMessageUuid: through, debriefedAt: at, attempts: 0, lastError: null, attemptedAt: null, attemptedThrough: null },
      },
      codex,
    };
  }

  /** The subagents a debrief that started at `startedAt` was shown, recorded as debriefed then. */
  static #shown(state: DebriefState, sessionId: string, agentIds: readonly string[], startedAt: string): DebriefState {
    return { ...state, subagents: { ...state.subagents, ...Object.fromEntries(agentIds.map((agentId) => [`${sessionId}/${agentId}`, startedAt])) } };
  }

  async #debrief(scan: ScanSettings, state: DebriefState, candidate: Candidate, range: DebriefRange): Promise<DebriefState> {
    const held = state.sessions[candidate.sessionId];

    const forkId = this.#deps.newId();
    // One clock read: the fork chooses subagents by it, and a success records it as their last debrief.
    const startedMs = this.#deps.now();
    const startedAt = new Date(startedMs).toISOString();
    const prefix = `${candidate.sessionId}/`;
    const subagentsDebriefed = Object.fromEntries(Object.entries(state.subagents).filter(([key]) => key.startsWith(prefix)).map(([key, at]) => [key.slice(prefix.length), at]));

    this.#deps.log.info(`debriefing ${candidate.sessionId}: ${range.toolCalls} tool calls since ${held?.throughMessageUuid ?? 'the start'}`, 'debrief');
    this.#forks.add(forkId);

    let result;

    try {
      result = await scan.signal.fork({
        path: scan.claudePath,
        sessionId: candidate.sessionId,
        forkId,
        cwd: candidate.cwd,
        prompt: promptFor(scan.prompt, range),
        timeoutMs: DEBRIEF_TIMEOUT_MS,
        signal: this.#abort.signal,
        readers: this.#deps.readers(),
        subagentsDebriefed,
        now: startedMs,
      });
    } finally {
      this.#forks.delete(forkId);
    }

    const at = new Date(this.#deps.now()).toISOString();

    if ('failure' in result) {
      const error = result.failure.message;
      const attempts = held?.attemptedThrough === range.throughMessageUuid ? held.attempts + 1 : 1;
      const next: DebriefState = {
        ...state,
        sessions: {
          ...state.sessions,
          [candidate.sessionId]: {
            throughMessageUuid: held?.throughMessageUuid ?? null,
            debriefedAt: held?.debriefedAt ?? null,
            attempts,
            lastError: error,
            attemptedAt: at,
            attemptedThrough: range.throughMessageUuid,
          },
        },
      };

      this.#deps.log.warn(`debrief of ${candidate.sessionId} failed (attempt ${attempts} of ${DEBRIEF_ATTEMPT_LIMIT}): ${error}`, 'debrief');

      return this.#save(scan, next);
    }

    const entry: DebriefLogEntry = {
      v: 1,
      at,
      provider: 'claude',
      sessionId: candidate.sessionId,
      parentSessionId: null,
      cwd: candidate.cwd,
      fromMessageUuid: held?.throughMessageUuid ?? null,
      throughMessageUuid: range.throughMessageUuid,
      skills: range.skills,
      toolCalls: range.toolCalls,
      cache: result.cache,
      friction: result.friction,
      startedAt,
      subagents: result.subagents,
      delegated: range.delegated,
    };

    this.#deps.log.info(`debriefed ${candidate.sessionId}: ${entry.friction.length} friction reports`, 'debrief');

    // A subagent's later work is what it wrote after this fork started.
    const covered = DebriefRunner.#covered(state, candidate.sessionId, candidate.cwd, range.throughMessageUuid, range.delegated, at);

    return this.#save(scan, DebriefRunner.#shown(covered, candidate.sessionId, result.subagents, startedAt), [entry]);
  }

  /**
   * Ask the Codex debrief command about each thread waiting for it. Run straight after a parent's debrief, this puts the
   * thread's line in the same pass as the parent's. A thread debriefed before is asked only about turns since then.
   */
  async #askCodex(scan: ScanSettings, state: DebriefState): Promise<DebriefState> {
    const waiting = Object.entries(state.codex).filter(([, held]) => codexDue(held, this.#deps.now())).map(([thread]) => thread);

    if (waiting.length === 0) return state;

    if (this.#deps.readers().mtime(scan.codexScript) === null) {
      this.#say('no-codex-script', `No Codex debrief command at ${scan.codexScript}; ${waiting.length} delegated sessions wait for it.`);
      return state;
    }

    let current = state;

    for (const thread of waiting) {
      if (!this.#current(scan)) break;

      const held = current.codex[thread]!;
      const debriefedAt = held.debriefedAt;
      const outcome = await this.#deps.runCodex(scan.codexScript, thread, scan.promptPath, debriefedAt, DEBRIEF_TIMEOUT_MS, this.#abort.signal);
      const at = new Date(this.#deps.now()).toISOString();
      let error: string | null = null;
      let line: DebriefLogEntry | null = null;

      if (outcome.ok) {
        let answer;

        try {
          answer = frictionAnswer.safeParse(JSON.parse(outcome.text));
        } catch {
          answer = null;
        }

        if (answer?.success) {
          line = {
            v: 1, at, provider: 'codex', sessionId: thread, parentSessionId: held.parentSessionId, cwd: held.cwd,
            fromMessageUuid: null, throughMessageUuid: null, skills: null, toolCalls: null, cache: null, friction: answer.data,
          };
        } else {
          error = `the Codex debrief answer was not the friction JSON: ${outcome.text.slice(0, 200)}`;
        }
      } else if (outcome.exitCode !== NOT_CODEX_EXIT) {
        error = outcome.detail;
      }

      const attempts = error === null ? 0 : held.attempts + 1;
      const next: CodexDebriefState = error === null
        ? { ...held, debriefedAt: line === null ? debriefedAt : at, lastError: null, pending: false, attempts, attemptedAt: null }
        : { ...held, debriefedAt, lastError: error, pending: attempts < DEBRIEF_ATTEMPT_LIMIT, attempts, attemptedAt: at };

      if (error !== null) this.#deps.log.warn(`Codex debrief of ${thread} failed (attempt ${attempts} of ${DEBRIEF_ATTEMPT_LIMIT}): ${error}`, 'debrief');

      current = this.#save(scan, { ...current, codex: { ...current.codex, [thread]: next } }, line === null ? [] : [line]);
    }

    return current;
  }

  /** Append the lines, then store the state; what cannot be stored is held, and stops model calls until a later scan stores it. */
  #save(scan: ScanSettings, next: DebriefState, lines: DebriefLogEntry[] = []): DebriefState {
    this.#unsaved = DebriefRunner.#persist(scan.store, scan.dir, next, lines);

    if (this.#unsaved !== null) this.#deps.log.warn(`could not write ${DebriefRunner.#unwritten(this.#unsaved)}; debriefs wait until it can be written`, 'debrief');

    return next;
  }

  /** What is left unstored: the lines from the first that could not be appended, and the state, or null when all is stored. */
  static #persist(store: DebriefStore, dir: string, state: DebriefState, lines: readonly DebriefLogEntry[]): { dir: string; lines: DebriefLogEntry[]; state: DebriefState } | null {
    const failed = lines.findIndex((line) => !store.appendLog(line));

    if (failed >= 0) return { dir, lines: lines.slice(failed), state };

    return store.writeState(state) ? null : { dir, lines: [], state };
  }

  static #unwritten(unsaved: { dir: string; lines: readonly DebriefLogEntry[] }): string {
    return unsaved.lines.length > 0 ? `${unsaved.dir}/log` : `${unsaved.dir}/state.json`;
  }
}

/** The Codex debrief command's environment: run the hub's own executable as Node, marked as a debrief. */
export function codexDebriefEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, ELECTRON_RUN_AS_NODE: '1', [DEBRIEF_ENV]: '1' };
}
