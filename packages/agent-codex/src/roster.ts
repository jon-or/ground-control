import { z } from 'zod';
import { linkOf } from '@ground-control/core';
import type { AgentReading, MachineDeps, ReadFailure, Session } from '@ground-control/core';
import { activityDirOf, codexHomeOf } from './hookScript.js';
import { activityOf, readMarker } from './phase.js';
import type { ActivityMarker } from './phase.js';
import { CODEX_AGENT_ID, CODEX_DISPLAY_NAME } from './ids.js';

/** Whether a process is still running. Injected, because a roster read is the one place the adapter touches the OS. */
export type PidAlive = (pid: number) => boolean;

const MARKER_FILE = /^(.+)\.json$/;

/** The names Codex gives its threads, which is the only place a session's own title is written. */
export function sessionIndexPathOf(home: string, env: NodeJS.ProcessEnv = {}): string {
  return `${codexHomeOf(home, env)}/session_index.jsonl`;
}

const indexEntry = z.object({ id: z.string(), thread_name: z.string().optional() });

/**
 * Thread names by id. The index carries only threads Codex has named, so a session missing from it has no title
 * rather than an unreadable one — a whole-file parse failure costs every title, which is why each line is its own.
 */
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
    // A session that ended removed its own marker, so nothing on this roster has reported an end (R24).
    finished: false,
    details: detailsOf(marker),
  };
}

/**
 * Every live Codex session, from the markers its hooks wrote. Codex has no command that lists them: `codex agents`
 * requires a daemon this platform does not run, and a second app-server reports another process's threads as
 * `notLoaded` (`docs/mechanics.md` §39). So the marker directory is the roster, and the pid in each marker is the
 * liveness — a process that was killed fired no `SessionEnd` and left its marker behind (§40).
 */
export function readRoster(
  deps: MachineDeps,
  alive: PidAlive,
  env: NodeJS.ProcessEnv = {},
  now: number = Date.now(),
): AgentReading {
  const dir = activityDirOf(deps.home);
  const names = deps.listDir(dir);

  // The install creates this directory, so its absence is a signal not yet in place rather than a failure to report.
  if (names === null) {
    return { sessions: [], failure: null };
  }

  const titles = threadNamesFrom(deps.readText(sessionIndexPathOf(deps.home, env)));
  const sessions: Session[] = [];
  let unreadable = 0;
  let unproven = 0;

  for (const name of names) {
    // The writer renames a temporary file into place, so a `<id>.json.<pid>.tmp` beside a marker is a write in
    // flight and is not a session — which the suffix is what excludes.
    const sessionId = MARKER_FILE.exec(name)?.[1];

    if (!sessionId) {
      continue;
    }

    const marker = readMarker(deps.home, sessionId, deps.readText, now);

    if (marker === null) {
      unreadable++;
      continue;
    }

    // A marker with no directory cannot be placed on a card, and neither absence can be inferred past: both are the
    // writer failing rather than the developer, so they are stated rather than hidden (R25).
    if (marker.cwd === null) {
      unreadable++;
      continue;
    }

    // No pid is no evidence the session is running, and a marker outlives the process that stopped without one.
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

/** The unreadable markers first: a file the board cannot parse is the fault a reinstall fixes. */
function failureFor(unreadable: number, unproven: number): ReadFailure | null {
  if (unreadable > 0) {
    return {
      subject: CODEX_AGENT_ID,
      kind: 'bad-response',
      message: `${CODEX_DISPLAY_NAME} left ${unreadable} session marker${unreadable === 1 ? '' : 's'} the board could not read.`,
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
