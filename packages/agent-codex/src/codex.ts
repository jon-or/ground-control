import type { AgentAdapter, AgentReading, MachineDeps, ReadFailure } from '@ground-control/core';
import { makeCodexActivity } from './activity.js';
import { makeCodexDispatcher } from './dispatch.js';
import type { StartProcess } from './dispatch.js';
import { makeHistoryReader, rolloutExists } from './history.js';
import { CODEX_AGENT_ID, CODEX_DISPLAY_NAME } from './ids.js';
import type { TrustHooks } from './appServer.js';
import type { TrustAttempt } from './exchange.js';
import { codexHomeOf } from './hookScript.js';
import { readRoster } from './roster.js';
import { trustFailure, trustState } from './trust.js';
import type { TrustState } from './trust.js';
import type { PidAlive } from './roster.js';

/** Signal 0 tests for a process without touching it. `EPERM` is a process this user may not signal, which is alive. */
export const pidAliveOnMachine: PidAlive = (pid) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** What the adapter needs of the machine beyond its files. Injected whole, so the package stays testable. */
export interface CodexMachine {
  /** Whether a process is still running, which is the roster's only liveness evidence. */
  alive: PidAlive;
  /** Where Codex keeps its home, and what a dispatched run inherits. */
  env: NodeJS.ProcessEnv;
  /** Starts a run and leaves it going. Absent where the board may not start work at all. */
  start?: StartProcess;
  /** End an adapter-started process. Supplied together with start for card actions (R39). */
  kill?: (pid: number) => boolean;
  /** Asks Codex to trust the hooks the board installed. Absent where nothing may spawn, which leaves them untrusted. */
  trust?: TrustHooks;
}

/**
 * Discover Codex sessions from hook markers and PID checks; no usable live-roster API was found on Windows
 * (mechanics M39, M40). Enable by default when Codex home exists. Stop authorization is limited to runs
 * dispatched by this adapter instance; it is not restored after a hub restart.
 */
export function makeCodexAdapter(machine: CodexMachine = { alive: pidAliveOnMachine, env: process.env }): AgentAdapter {
  const { alive, env, start, kill, trust } = machine;
  const history = makeHistoryReader(env);

  // Which set of untrusted keys the board has already asked Codex about, and what came of it. Keyed by the set so a
  // reinstall that changes a command — which re-arms trust — is asked again, and a Codex that keeps refusing is not.
  const asked = new Map<string, TrustAttempt>();

  // Only the runs the board started. Filled by the dispatch itself, so a run whose hooks are not installed or not
  // trusted is still stoppable (M41), and never by a roster read — the roster sees every session on the machine,
  // including the developer's own, and a stop must not be able to reach one of those.
  const dispatched = new Map<string, number | null>();

  // Roster PIDs can fill a missing dispatch PID, but cannot authorize stopping an unrecorded dispatch.
  const observed = new Map<string, number>();

  /**
   * Starts one attempt to have Codex trust the entries in `state`, and reports what a previous attempt on the same
   * entries came to. Never awaited: the exchange spawns a process, and a roster read that waited on one would hold
   * up every other agent's sessions. So the read that starts it says nothing, and the next one — 30 s later, by
   * which time the markers are being written — has the answer.
   */
  function askAbout(state: TrustState, path: string, home: string): TrustAttempt {
    if (state.untrusted.length === 0 || !trust) {
      return null;
    }

    const signature = state.untrusted.join('\n');

    if (!asked.has(signature)) {
      // Recorded before the exchange finishes, so a second read while one is in flight does not start another.
      asked.set(signature, null);
      void trust(path, home).then(
        (attempt) => asked.set(signature, attempt),
        (error: Error) => asked.set(signature, error.message),
      );
    }

    return asked.get(signature) ?? null;
  }

  return {
    id: CODEX_AGENT_ID,
    displayName: CODEX_DISPLAY_NAME,
    defaultPath: 'codex',
    // R30: Codex's own home is the evidence it is installed, and a roster read needs nothing else — `listSessions`
    // ignores the path, so a detected agent works with no setting and a machine without Codex is never polled.
    enabledByDefault: (readers) => readers.listDir(codexHomeOf(readers.home, env)) !== null,
    activity: makeCodexActivity(env),
    listHistory: history,
    ...(start && kill
      ? {
          dispatch: makeCodexDispatcher(start, (threadId, pid) => dispatched.set(threadId, pid)),
          stopDispatch: stopper(dispatched, observed, kill),
        }
      : {}),

    // A thread is addressed by its id alone — the reveal opened one whose recorded directory was somewhere else
    // entirely (M44) — so what settles a resume is whether Codex still holds the rollout, not where it ran.
    canResume: (session, deps) => rolloutExists(session.sessionId, deps, env),

    listSessions(path: string, deps: MachineDeps): Promise<AgentReading> {
      const roster = readRoster(deps, alive, env);
      const state = trustState(deps, env);

      // A marker the board cannot read first: that is a fault in what the hook wrote, where untrusted entries wrote
      // nothing at all. Trust is asked about only once the roster has no fault of its own to report.
      const reading: AgentReading =
        roster.failure === null ? { ...roster, failure: trustFailure(state, askAbout(state, path, deps.home)) } : roster;

      // Refreshed rather than replaced: a read that finds nothing — the signal turned off, the directory not there
      // yet — must not strip the stop control from a run that is still going.
      for (const session of reading.sessions) {
        if (session.pid !== null) {
          observed.set(session.sessionId, session.pid);
        }
      }

      return Promise.resolve(reading);
    },
  };
}

/**
 * Stop only threads dispatched by this adapter instance, using the spawn PID or a roster PID fallback.
 * The authorization map is not persisted, so a hub restart loses stop access to prior runs.
 */
function stopper(
  dispatched: ReadonlyMap<string, number | null>,
  observed: ReadonlyMap<string, number>,
  kill: (pid: number) => boolean,
) {
  return function stopDispatch(_path: string, shortId: string): Promise<ReadFailure | null> {
    if (!dispatched.has(shortId)) {
      return Promise.resolve({
        subject: CODEX_AGENT_ID,
        kind: 'stop-unknown',
        message: `The board did not start ${CODEX_DISPLAY_NAME} thread ${shortId}, so it did not stop it.`,
        remedy: 'Stop the session in Codex.',
      });
    }

    const pid = dispatched.get(shortId) ?? observed.get(shortId);

    if (pid === undefined || pid === null) {
      return Promise.resolve({
        subject: CODEX_AGENT_ID,
        kind: 'stop-unknown',
        message: `The board does not know which process ${CODEX_DISPLAY_NAME} thread ${shortId} is running in, so it did not stop it.`,
        remedy: 'Refresh the board, and stop the session in Codex if it is still running.',
      });
    }

    return Promise.resolve(
      kill(pid)
        ? null
        : {
            subject: CODEX_AGENT_ID,
            kind: 'stop-failed',
            message: `The board could not stop ${CODEX_DISPLAY_NAME} thread ${shortId}: nothing answered for process ${pid}.`,
            remedy: 'The run may already have finished. Check it in Codex, and end the process yourself if it is still going.',
          },
    );
  };
}
