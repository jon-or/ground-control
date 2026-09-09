import type { AgentAdapter, AgentReading, MachineDeps, ReadFailure } from '@ground-control/core';
import { makeCodexActivity } from './activity.js';
import { DISPATCH_PERMISSIONS, makeCodexDispatcher } from './dispatch.js';
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

/** Check process existence with signal 0. EPERM also indicates an existing process. */
export const pidAliveOnMachine: PidAlive = (pid) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Injected process and environment dependencies. */
export interface CodexMachine {
  /** Process liveness check for roster entries. */
  alive: PidAlive;
  /** Environment used for Codex storage and dispatched runs. */
  env: NodeJS.ProcessEnv;
  /** Start detached work; absent when dispatch is unavailable. */
  start?: StartProcess;
  /** End an adapter-started process. Supplied together with start for card actions (R39). */
  kill?: (pid: number) => boolean;
  /** Trust installed board hooks; absent when process spawning is unavailable. */
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

  // Cache trust attempts by untrusted key set. Retry when changed commands require trust, but do not repeat a
  // failed attempt for unchanged keys.
  const asked = new Map<string, TrustAttempt>();

  // Authorize stops only for adapter dispatches, including runs without working hooks (M41). Roster reads must
  // not authorize stopping user-started sessions.
  const dispatched = new Map<string, number | null>();

  // Roster PIDs can fill a missing dispatch PID, but cannot authorize stopping an unrecorded dispatch.
  const observed = new Map<string, number>();

  /**
   * Start hook trust asynchronously and return any prior result for the same keys. Roster reads must not wait
   * for the subprocess; later polls receive the result.
   */
  function askAbout(state: TrustState, path: string, home: string): TrustAttempt {
    if (state.untrusted.length === 0 || !trust) {
      return null;
    }

    const signature = state.untrusted.join('\n');

    if (!asked.has(signature)) {
      // Record the pending attempt before another roster read can start a duplicate.
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
    // Detect Codex by its home directory. Roster reads do not require a configured executable path (R30).
    enabledByDefault: (readers) => readers.listDir(codexHomeOf(readers.home, env)) !== null,
    activity: makeCodexActivity(env),
    listHistory: history,
    ...(start && kill
      ? {
          dispatch: makeCodexDispatcher(start, (threadId, pid) => dispatched.set(threadId, pid)),
          dispatchPermissions: DISPATCH_PERMISSIONS,
          stopDispatch: stopper(dispatched, observed, kill),
        }
      : {}),

    // Resume requires an existing rollout; thread IDs are independent of their original checkout directory
    // (M44).
    canResume: (session, deps) => rolloutExists(session.sessionId, deps, env),

    listSessions(path: string, deps: MachineDeps): Promise<AgentReading> {
      const roster = readRoster(deps, alive, env);
      const state = trustState(deps, env);

      // Report invalid markers before trust failures; untrusted hooks produce no markers.
      const reading: AgentReading =
        roster.failure === null ? { ...roster, failure: trustFailure(state, askAbout(state, path, deps.home)) } : roster;

      // Merge roster PIDs without removing dispatches when markers are absent, preserving stop access.
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
        message: `Cannot stop ${CODEX_DISPLAY_NAME} thread ${shortId}: it was not started by Ground Control.`,
        remedy: 'Stop the session in Codex.',
      });
    }

    const pid = dispatched.get(shortId) ?? observed.get(shortId);

    if (pid === undefined || pid === null) {
      return Promise.resolve({
        subject: CODEX_AGENT_ID,
        kind: 'stop-unknown',
        message: `Cannot stop ${CODEX_DISPLAY_NAME} thread ${shortId}: process ID unknown.`,
        remedy: 'Refresh the board, and stop the session in Codex if it is still running.',
      });
    }

    return Promise.resolve(
      kill(pid)
        ? null
        : {
            subject: CODEX_AGENT_ID,
            kind: 'stop-failed',
            message: `Could not stop ${CODEX_DISPLAY_NAME} thread ${shortId}: process ${pid} did not respond.`,
            remedy: 'Check the session in Codex. If it is still running, stop its process manually.',
          },
    );
  };
}
