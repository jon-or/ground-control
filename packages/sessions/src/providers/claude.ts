import { z } from 'zod';
import { linkOf } from '../link.js';
import { normalize } from '../paths.js';
import { readActivity } from '../phase.js';
import type { ListDir, ProviderDeps, ProviderReading, ReadTail, SessionProvider, StatMtime } from '../provider.js';
import type { Failure, Session } from '../types.js';
import { runJsonCli } from './exec-json.js';
import type { ExecJson } from './exec-json.js';

export const CLAUDE_AGENT_ID = 'claude';
export const CLAUDE_DISPLAY_NAME = 'Claude Code';

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
});

export type AgentEntry = z.infer<typeof agentEntry>;

/**
 * A cwd's project-slug directory under ~/.claude/projects: every character that is not a letter or digit becomes
 * `-`, runs not collapsed. Measured with a probe directory; `docs/mechanics.md` §3 carries the evidence.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function projectsRoot(home: string): string {
  return `${normalize(home).replace(/\/+$/, '')}/.claude/projects`;
}

interface TranscriptDeps {
  mtime: StatMtime;
  listDir: ListDir;
}

/**
 * How much of a transcript's end is read to find its title — twice the measured worst in-reach case, which is the
 * margin a turn's writes can grow by before the title leaves the window. `docs/mechanics.md` §3b carries the
 * measurement and why no window catches every session. Exported so a fixture recording uses the same one.
 */
export const TITLE_TAIL_BYTES = 64 * 1024;

/**
 * Every directory that could hold this session, exact case first: a project directory's case is fixed by whichever
 * path first created it, and the CLI reports one checkout under either drive-letter case (`docs/mechanics.md` §3).
 */
export function transcriptCandidates(home: string, cwd: string, sessionId: string, listDir: ListDir): string[] {
  const root = projectsRoot(home);
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
  /** Epoch milliseconds. Never liveness: a live session's transcript can be hours old, or absent entirely. */
  writtenAt: number;
}

/** The session's transcript, or null when it has none anywhere under the projects root. */
export function findTranscript(
  home: string,
  cwd: string,
  sessionId: string,
  deps: TranscriptDeps,
): Transcript | null {
  for (const candidate of transcriptCandidates(home, cwd, sessionId, deps.listDir)) {
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
 * The session's title from the end of its transcript. A title the developer set outranks whatever came last, because
 * the CLI goes on writing its own after one is set (`docs/mechanics.md` §3b); a tail short of that record reads as
 * automatic.
 */
export function titleFrom(tail: string, sessionId: string): string | null {
  let automatic: string | null = null;
  let manual: string | null = null;

  for (const line of tail.split('\n')) {
    // A conversation line rarely holds the word, and parsing 64 kB of one per session per refresh is the cost avoided.
    if (!line.includes('title')) {
      continue;
    }

    let record;

    try {
      record = titleRecord.safeParse(JSON.parse(line));
    } catch {
      // The first line of a tail is a fragment of whatever the read cut through.
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

function failure(kind: Failure['kind'], message: string, remedy: string): Failure {
  return { agent: CLAUDE_AGENT_ID, kind, message, remedy };
}

const PATH_SETTING = `the "${CLAUDE_AGENT_ID}" entry in groundControl.agents`;

function toSession(entry: AgentEntry, deps: ProviderDeps): Session {
  const link = linkOf(entry.cwd, deps.readText, deps.pattern);
  const transcript = findTranscript(deps.home, entry.cwd, entry.sessionId, deps);

  return {
    agent: CLAUDE_AGENT_ID,
    sessionId: entry.sessionId,
    pid: entry.pid ?? null,
    shortId: entry.id ?? null,
    name: entry.name ?? null,
    title: transcriptTitle(transcript, entry.sessionId, deps.readTail),
    cwd: entry.cwd,
    kind: entry.kind,
    startedAt: entry.startedAt,
    status: entry.status ?? null,
    state: entry.state ?? null,
    branch: link.branch,
    issueNumber: link.issueNumber,
    transcriptWrittenAt: transcript?.writtenAt ?? null,
    activity: readActivity(deps.home, entry.sessionId, deps.readText),
  };
}

/**
 * A session that has never been prompted — an editor tab opened and left alone. The CLI creates the transcript at the
 * first user turn, not at process start (`docs/mechanics.md` §3), the one hook that fires before a turn claims no phase,
 * and a background session reports its own status: three independent signals, all silent only for work that never began.
 */
export function neverPrompted(session: Session): boolean {
  return (
    session.transcriptWrittenAt === null &&
    session.activity === null &&
    session.status === null &&
    session.state === null
  );
}

/** The transport is the provider's own, so a test supplies a recorded one without the interface knowing. */
export function makeClaudeProvider(run: ExecJson = runJsonCli): SessionProvider {
  return {
    id: CLAUDE_AGENT_ID,
    defaultPath: 'claude',
    defaultEnabled: true,

    /**
     * `--all` is deliberately not passed: it also returns exited background sessions, and R2 asks for the active
     * ones while R9 says finished work leaves the board.
     */
    async listSessions(path: string, deps: ProviderDeps): Promise<ProviderReading> {
      const outcome = await run(path, ['agents', '--json']);

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
              `${CLAUDE_DISPLAY_NAME} answered \`agents --json\` with output that is not JSON: ${outcome.detail}`,
              `Run \`${path} agents --json\` in a terminal to see the whole of it.`,
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
          const session = toSession(parsed.data, deps);

          if (!neverPrompted(session)) {
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
