import { z } from 'zod';
import { linkOf } from '@ground-control/core';
import type { AgentReading, MachineDeps, ReadFailure, Session } from '@ground-control/core';
import { activityDirOf, codexHomeOf } from './hookScript.js';
import { activityOf, markerInProfile, readMarker } from './phase.js';
import type { ActivityMarker } from './phase.js';
import { CODEX_AGENT_ID, CODEX_DISPLAY_NAME } from './ids.js';

/** Injected process liveness check. */
export type PidAlive = (pid: number) => boolean;

const MARKER_FILE = /^(.+)\.json$/;

/** Codex thread-name index, the source of session titles. */
export function sessionIndexPathOf(home: string, env: NodeJS.ProcessEnv = {}): string {
  return `${codexHomeOf(home, env).replace(/\/$/, '')}/session_index.jsonl`;
}

const indexEntry = z.object({ id: z.string(), thread_name: z.string().optional() });

/** Read named threads by ID. Parse lines independently so a malformed entry does not discard other titles. */
export function threadNamesFrom(text: string | null): Map<string, string> {
  const names = new Map<string, string>();

  for (const line of (text ?? '').split('\n')) {
    let parsed;

    try {
      parsed = indexEntry.safeParse(JSON.parse(line));
    } catch {
      continue;
    }

    const name = parsed.success ? parsed.data.thread_name?.trim() : '';

    if (parsed.success && name) {
      names.set(parsed.data.id, name);
    }
  }

  return names;
}

function detailsOf(marker: ActivityMarker): Record<string, string> {
  const details: Record<string, string> = {};

  for (const [key, value] of [
    ['model', marker.model],
    ['permissionMode', marker.permissionMode],
    ['source', marker.source],
  ] as const) {
    if (value !== null) {
      details[key] = value;
    }
  }

  return details;
}

function toSession(marker: ActivityMarker, cwd: string, title: string | null, deps: MachineDeps): Session {
  const link = linkOf(cwd, deps.readText, deps.pattern);

  return {
    agent: CODEX_AGENT_ID,
    sessionId: marker.sessionId,
    pid: marker.pid,
    title,
    cwd,
    checkoutRoot: link.checkoutRoot,
    startedAt: marker.startedAt,
    branch: link.branch,
    repository: link.repository,
    issueNumber: link.issueNumber,
    transcriptWrittenAt: marker.transcriptPath === null ? null : deps.mtime(marker.transcriptPath),
    activity: activityOf(marker),
    // `SessionEnd` removes the marker, so roster entries have not reported completion (R24).
    finished: false,
    // `codex exec` has no attach command; open plans resume dispatched threads.
    attachId: null,
    details: detailsOf(marker),
  };
}

/**
 * Read hook markers and check their PIDs for liveness. `codex agents` requires an unavailable daemon, and
 * another app-server reports threads as `notLoaded` (M39). PID checks exclude markers left after termination
 * without `SessionEnd` (M40).
 */
export function readRoster(
  deps: MachineDeps,
  alive: PidAlive,
  env: NodeJS.ProcessEnv = {},
  now: number = Date.now(),
): AgentReading {
  const dir = activityDirOf(deps.home);
  const names = deps.listDir(dir);

  // The installer creates this directory; absence means hooks are not installed yet.
  if (names === null) {
    return { sessions: [], failure: null };
  }

  const titles = threadNamesFrom(deps.readText(sessionIndexPathOf(deps.home, env)));
  const sessions: Session[] = [];
  let unreadable = 0;
  let unproven = 0;

  for (const name of names) {
    // Exclude temporary `<id>.json.<pid>.tmp` files used for atomic marker writes.
    const sessionId = MARKER_FILE.exec(name)?.[1];

    if (!sessionId) {
      continue;
    }

    const marker = readMarker(deps.home, sessionId, deps.readText, now);

    if (marker === null) {
      unreadable++;
      continue;
    }

    if (!markerInProfile(marker, deps.home, env)) continue;

    // A missing directory prevents card linking and indicates an invalid marker (R25).
    if (marker.cwd === null) {
      unreadable++;
      continue;
    }

    // A marker without a PID cannot establish liveness.
    if (marker.pid === null) {
      unproven++;
      continue;
    }

    if (alive(marker.pid)) {
      sessions.push(toSession(marker, marker.cwd, titles.get(sessionId) ?? null, deps));
    }
  }

  return { sessions, failure: failureFor(unreadable, unproven) };
}

/** Prioritize unreadable markers, which may require hook reinstallation. */
function failureFor(unreadable: number, unproven: number): ReadFailure | null {
  if (unreadable > 0) {
    return {
      subject: CODEX_AGENT_ID,
      kind: 'bad-response',
      message: `${unreadable} ${CODEX_DISPLAY_NAME} session marker${unreadable === 1 ? '' : 's'} could not be read.`,
      remedy: 'Reinstall the activity hook from the board menu, and report it if it persists.',
    };
  }

  if (unproven > 0) {
    return {
      subject: CODEX_AGENT_ID,
      kind: 'bad-response',
      message: `The board cannot tell whether ${unproven} ${CODEX_DISPLAY_NAME} session${unproven === 1 ? '' : 's'} ${unproven === 1 ? 'is' : 'are'} still running, so ${unproven === 1 ? 'it is' : 'they are'} not shown.`,
      remedy: `The hook could not find the ${CODEX_DISPLAY_NAME} process its session runs in. Ending the session clears this; reinstall the hook from the board menu if it persists.`,
    };
  }

  return null;
}
