import { z } from 'zod';
import { PERMISSION_MODES, linkOf, runJsonCli, runTextCli } from '@ground-control/core';
import type {
  AgentAdapter,
  AgentReading,
  ExecJson,
  ExecText,
  ListDir,
  MachineDeps,
  ReadFailure,
  ReadTail,
  Session,
  StatMtime,
} from '@ground-control/core';
import { makeClaudeActivity } from './activity.js';
import { makeClaudeClassifier } from './classify.js';
import { makeClaudeDispatcher, makeClaudeStopper } from './dispatch.js';
import { CLAUDE_AGENT_ID, CLAUDE_DISPLAY_NAME } from './ids.js';
import { readActivity } from './phase.js';
import { makeHistoryReader } from './history.js';
import { claudeHomeOf } from './hookScript.js';



/**
 * `status` and `state` are the `--bg` shape; interactive sessions carry neither, and neither does a short `id`.
 * `kind` stays a string so an unfamiliar kind shows up rather than dropping the session.
 */
const agentEntry = z.object({
  pid: z.number().optional(),
  cwd: z.string(),
  kind: z.string(),
  /** Epoch milliseconds, as `claude agents --json` reports it. */
  startedAt: z.number(),
  sessionId: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  state: z.string().optional(),
  /** Wait reason, observed as permission prompt. */
  waitingFor: z.string().optional(),
});

export type AgentEntry = z.infer<typeof agentEntry>;

/**
 * Encode the cwd as a project slug by replacing each nonalphanumeric character with a hyphen, without
 * collapsing repeats (M3).
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function projectsRoot(home: string, env: NodeJS.ProcessEnv = {}): string {
  return `${claudeHomeOf(home, env).replace(/\/$/, '')}/projects`;
}

interface TranscriptDeps {
  mtime: StatMtime;
  listDir: ListDir;
}

/**
 * Transcript tail limit: twice the largest measured distance to an accessible title. Some sessions still have
 * no title within this limit (M3b). Exported for fixture recording.
 */
export const TITLE_TAIL_BYTES = 64 * 1024;

/**
 * Try exact-case project slugs first, then case variants. The CLI can report drive-letter casing different from
 * the directory created earlier (M3).
 */
export function transcriptCandidates(home: string, cwd: string, sessionId: string, listDir: ListDir, env: NodeJS.ProcessEnv = {}): string[] {
  const root = projectsRoot(home, env);
  const names = listDir(root);

  if (!names) {
    return [];
  }

  const slug = projectSlug(cwd);
  const lowered = slug.toLowerCase();
  const exact = names.filter((name) => name === slug);
  const variants = names.filter((name) => name !== slug && name.toLowerCase() === lowered);

  return [...exact, ...variants].map((name) => `${root}/${name}/${sessionId}.jsonl`);
}

export interface Transcript {
  path: string;
  /** Transcript mtime in epoch milliseconds; old or absent transcripts do not establish liveness. */
  writtenAt: number;
}

/** The session's transcript, or null when it has none anywhere under the projects root. */
export function findTranscript(
  home: string,
  cwd: string,
  sessionId: string,
  deps: TranscriptDeps,
  env: NodeJS.ProcessEnv = {},
): Transcript | null {
  for (const candidate of transcriptCandidates(home, cwd, sessionId, deps.listDir, env)) {
    const writtenAt = deps.mtime(candidate);

    if (writtenAt !== null) {
      return { path: candidate, writtenAt };
    }
  }

  return null;
}

const titleRecord = z.object({
  type: z.enum(['ai-title', 'custom-title']),
  sessionId: z.string(),
  aiTitle: z.string().optional(),
  customTitle: z.string().optional(),
});

/**
 * Prefer the latest manual title within the tail, then the latest automatic title. Claude continues writing
 * automatic titles after a manual rename (M3b).
 */
export function titleFrom(tail: string, sessionId: string): string | null {
  let automatic: string | null = null;
  let manual: string | null = null;

  for (const line of tail.split('\n')) {
    // Skip JSON parsing for lines without title fields.
    if (!line.includes('title')) {
      continue;
    }

    let record;

    try {
      record = titleRecord.safeParse(JSON.parse(line));
    } catch {
      // The tail may start with an incomplete JSON record.
      continue;
    }

    if (!record.success || record.data.sessionId !== sessionId) {
      continue;
    }

    manual = record.data.customTitle?.trim() || manual;
    automatic = record.data.aiTitle?.trim() || automatic;
  }

  return manual ?? automatic;
}

/** The title of the session's transcript, or null when it has no transcript or no title in the tail that was read. */
export function transcriptTitle(transcript: Transcript | null, sessionId: string, readTail: ReadTail): string | null {
  const tail = transcript && readTail(transcript.path, TITLE_TAIL_BYTES);

  return tail ? titleFrom(tail, sessionId) : null;
}

type FailureKind = 'agent-missing' | 'agent-failed' | 'bad-response';

function failure(kind: FailureKind, message: string, remedy: string): ReadFailure {
  return { subject: CLAUDE_AGENT_ID, kind, message, remedy };
}

const PATH_SETTING = `the "${CLAUDE_AGENT_ID}" entry in groundControl.agents`;

/**
 * Agent-specific details: short background ID, kind, status, and normalized state. Omit undefined fields to
 * preserve absence.
 */
function detailsOf(entry: AgentEntry): Record<string, string> {
  const details: Record<string, string> = { kind: entry.kind };

  for (const [key, value] of [
    ['name', entry.name],
    ['shortId', entry.id],
    ['status', entry.status],
    ['state', reportedState(entry)],
    ['waitingFor', entry.waitingFor],
  ] as const) {
    if (value !== undefined) {
      details[key] = value;
    }
  }

  return details;
}

/**
 * Normalize CLI states to board phases; preserve unknown values. needs_reply and needs_approval mean waiting
 * (M33), with the wait reason taking precedence over tempo.
 */
export function reportedState(entry: AgentEntry): string | undefined {
  if (entry.waitingFor !== undefined) {
    return `waiting on a ${entry.waitingFor}`;
  }

  switch (entry.state) {
    case 'working':
      return 'running';
    case 'blocked':
      return 'waiting';
    case 'done':
    case 'stopped':
      return 'idle';
    default:
      return entry.state;
  }
}

/** CLI terminal states for background sessions. */
const FINISHED_STATES = new Set(['done', 'stopped']);

function toSession(entry: AgentEntry, deps: MachineDeps, env: NodeJS.ProcessEnv): Session {
  const link = linkOf(entry.cwd, deps.readText, deps.pattern);
  const transcript = findTranscript(deps.home, entry.cwd, entry.sessionId, deps, env);

  return {
    agent: CLAUDE_AGENT_ID,
    sessionId: entry.sessionId,
    pid: entry.pid ?? null,
    title: transcriptTitle(transcript, entry.sessionId, deps.readTail),
    cwd: entry.cwd,
    checkoutRoot: link.checkoutRoot,
    startedAt: entry.startedAt,
    branch: link.branch,
    repository: link.repository,
    issueNumber: link.issueNumber,
    transcriptWrittenAt: transcript?.writtenAt ?? null,
    activity: readActivity(deps.home, entry.sessionId, deps.readText),
    // Idle is not terminal for interactive sessions. Only explicit CLI terminal states mark completion (R24).
    finished: entry.state !== undefined && FINISHED_STATES.has(entry.state),
    // Only live background sessions support attach; ended sessions return No job matching (M33).
    attachId: entry.kind === 'background' && !FINISHED_STATES.has(entry.state ?? '') ? (entry.id ?? null) : null,
    details: detailsOf(entry),
  };
}

/**
 * Identify unprompted editor sessions by absent transcript, activity phase, and background status. Claude
 * creates transcripts at the first user turn (M3).
 */
export function neverPrompted(session: Session, entry: AgentEntry): boolean {
  return (
    session.transcriptWrittenAt === null &&
    session.activity === null &&
    entry.status === undefined &&
    entry.state === undefined
  );
}

/** Inject separate transports for JSON roster reads and text --bg output (M33). */
export function makeClaudeAdapter(run: ExecJson = runJsonCli, runText: ExecText = runTextCli, env: NodeJS.ProcessEnv = process.env): AgentAdapter {
  const base = { ...env };
  let root: string | undefined;
  const environment = () => ({ ...base, ...(root === undefined ? {} : { CLAUDE_CONFIG_DIR: root }) });
  const dispatched = new Map<string, NodeJS.ProcessEnv>();
  return {
    id: CLAUDE_AGENT_ID,
    displayName: CLAUDE_DISPLAY_NAME,
    defaultPath: 'claude',
    storage: { environment: 'CLAUDE_CONFIG_DIR', defaultDirectory: '.claude', configure: (value) => { root = value; } },
    // The board creates ~/.claude itself, so that directory cannot establish Claude installation. Keep Claude
    // enabled by default.
    enabledByDefault: () => true,
    activity: makeClaudeActivity(environment),
    classify: makeClaudeClassifier((path, args, options) => run(path, args, { ...options, env: environment() })),
    async dispatch(input) {
      const env = environment();
      const result = await makeClaudeDispatcher((path, args, options) => runText(path, args, { ...options, env }))(input);
      if ('shortId' in result) dispatched.set(result.shortId, env);
      return result;
    },
    dispatchPermissions: PERMISSION_MODES,
    stopDispatch: (path, shortId) => makeClaudeStopper((path, args, options) =>
      runText(path, args, { ...options, env: dispatched.get(shortId) ?? environment() }))(path, shortId),
    listHistory: makeHistoryReader(environment),
    canResume: (session, deps) => deps.listDir(session.cwd) !== null && findTranscript(deps.home, session.cwd, session.sessionId, deps, environment()) !== null,

    /** Omit --all to exclude exited background sessions (R2, R9). */
    async listSessions(path: string, deps: MachineDeps): Promise<AgentReading> {
      const env = environment();
      const outcome = await run(path, ['agents', '--json'], { env });

      if (!outcome.ok) {
        if (outcome.reason === 'missing') {
          return {
            sessions: [],
            failure: failure(
              'agent-missing',
              `${CLAUDE_DISPLAY_NAME} was not found at "${path}", so its sessions are not on the board.`,
              `Install ${CLAUDE_DISPLAY_NAME}, or set ${PATH_SETTING} to its full path.`,
            ),
          };
        }

        if (outcome.reason === 'not-executable') {
          return {
            sessions: [],
            failure: failure(
              'agent-missing',
              `${CLAUDE_DISPLAY_NAME} at "${path}" cannot be run directly: ${outcome.detail}.`,
              `Set ${PATH_SETTING} to the executable the shim wraps.`,
            ),
          };
        }

        if (outcome.reason === 'unparsable') {
          return {
            sessions: [],
            failure: failure(
              'bad-response',
              `${CLAUDE_DISPLAY_NAME} returned non-JSON output for \`agents --json\`: ${outcome.detail}`,
              `Run \`${path} agents --json\` in a terminal to see the full output.`,
            ),
          };
        }

        return {
          sessions: [],
          failure: failure(
            'agent-failed',
            `${CLAUDE_DISPLAY_NAME} could not list its sessions: ${outcome.detail}`,
            `Run \`${path} agents --json\` in a terminal to see what it printed, and check ${PATH_SETTING}.`,
          ),
        };
      }

      const array = z.array(z.unknown()).safeParse(outcome.value);

      if (!array.success) {
        return {
          sessions: [],
          failure: failure(
            'bad-response',
            `${CLAUDE_DISPLAY_NAME} did not return a list of sessions.`,
            'The CLI may have changed. Refresh, and report it if it persists.',
          ),
        };
      }

      const sessions: Session[] = [];
      let firstBadEntry: string | undefined;
      let dropped = 0;

      for (const raw of array.data) {
        const parsed = agentEntry.safeParse(raw);

        if (parsed.success) {
          const session = toSession(parsed.data, deps, env);

          if (!neverPrompted(session, parsed.data)) {
            sessions.push(session);
          }

          continue;
        }

        dropped++;
        const issue = parsed.error.issues[0];
        firstBadEntry ??= `${issue?.path.join('.')} ${issue?.message}`;
      }

      return {
        sessions,
        failure:
          dropped === 0
            ? null
            : failure(
                'bad-response',
                `${CLAUDE_DISPLAY_NAME} listed ${dropped} session${dropped === 1 ? '' : 's'} the board could not read: ${firstBadEntry}.`,
                'The CLI may have changed. Refresh, and report it if it persists.',
              ),
      };
    },
  };
}
