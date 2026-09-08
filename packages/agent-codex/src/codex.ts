import type { AgentAdapter, AgentReading, MachineDeps, ReadFailure } from '@ground-control/core';
import { makeCodexActivity } from './activity.js';
import { makeCodexDispatcher } from './dispatch.js';
import type { StartProcess } from './dispatch.js';
import { makeHistoryReader, rolloutExists } from './history.js';
import { CODEX_AGENT_ID, CODEX_DISPLAY_NAME } from './ids.js';
import { readRoster } from './roster.js';
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
  /** Ends a process the board started. Absent with `start`, since a run nobody can stop must not be offered (R15). */
  kill?: (pid: number) => boolean;
}

/**
 * The Codex adapter. R30 keeps it off until a developer enables it, so a machine without Codex is never nagged.
 *
 * The roster is the one thing this adapter does differently from every other: Codex has no session list to read.
 * `codex agents` requires an app-server daemon that only runs on Unix, and a second app-server process reports
 * another one's threads as `notLoaded`, so the hook markers are the roster and the pid each marker carries is the
 * liveness (`docs/mechanics.md` §39, §40).
 *
 * That pid is also what makes a dispatch stoppable. Codex has no `claude stop`: a run is ended by signalling the
 * process, and the process is the one its own marker names — which every roster read refreshes, so a hub that
 * restarted can still stop a run it did not start (R15).
 */
export function makeCodexAdapter(machine: CodexMachine = { alive: pidAliveOnMachine, env: process.env }): AgentAdapter {
  const { alive, env, start, kill } = machine;
  const history = makeHistoryReader(env);

  // Only the runs the board started. Filled by the dispatch itself, so a run whose hooks are not installed or not
  // trusted is still stoppable (§41), and never by a roster read — the roster sees every session on the machine,
  // including the developer's own, and a stop must not be able to reach one of those.
  const dispatched = new Map<string, number | null>();

  // What the markers say those runs are running in, refreshed by every read: it is what lets a hub that restarted
  // stop a run it did not start itself.
  const observed = new Map<string, number>();

  return {
    id: CODEX_AGENT_ID,
    displayName: CODEX_DISPLAY_NAME,
    defaultPath: 'codex',
    defaultEnabled: false,
    activity: makeCodexActivity(env),
    listHistory: history,
    ...(start && kill
      ? {
          dispatch: makeCodexDispatcher(start, (threadId, pid) => dispatched.set(threadId, pid)),
          stopDispatch: stopper(dispatched, observed, kill),
        }
      : {}),

    // A thread is addressed by its id alone — the reveal opened one whose recorded directory was somewhere else
    // entirely (§44) — so what settles a resume is whether Codex still holds the rollout, not where it ran.
    canResume: (session, deps) => rolloutExists(session.sessionId, deps, env),

    listSessions(_path: string, deps: MachineDeps): Promise<AgentReading> {
      const reading = readRoster(deps, alive, env);

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
 * Ends a run the board started. The process it spawned first, because that one is known from the moment of the
 * dispatch; the marker's pid second, which is what a hub that restarted has instead. A thread the board never
 * dispatched is refused outright — the roster knows every Codex process on the machine, the developer's own
 * included, and a stop must not be able to reach one of those.
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
