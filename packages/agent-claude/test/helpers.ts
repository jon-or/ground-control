import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  AgentAdapter,
  ExecJson,
  ExecOutcome,
  ListDir,
  MachineReaders,
  ReadTail,
  ReadText,
  SessionsConfig,
  StatMtime,
} from '@ground-control/core';
import { makeClaudeAdapter } from '../src/claude.js';

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));
}

/** One recorded title record, exactly as the transcript held it — only the title text is anonymised. */
export interface TitleRecord {
  type: 'ai-title' | 'custom-title';
  sessionId: string;
  aiTitle?: string;
  customTitle?: string;
}

export interface TranscriptEntry {
  name: string | null;
  cwd: string;
  sessionId: string;
  /** The project directory the transcript was actually found in, which is not always the exact-case slug. */
  dir: string | null;
  writtenAt: number | null;
  /** The title records inside the window the reader reads, in the order the transcript held them. */
  titles: TitleRecord[];
  /** How far from the transcript's end its last title record sat, or null where it had none. */
  titleBytesFromEnd: number | null;
}

export interface TranscriptFixture {
  home: string;
  projectDirs: string[];
  entries: TranscriptEntry[];
}

/**
 * Every field a recorded entry must carry. A cast is not a check: a row missing one reads `undefined` where the type
 * promised a value, and nothing fails until something reads it. `satisfies` fails the typecheck the day
 * `TranscriptEntry` grows a field, and the row check fails the run until the recording is refreshed.
 */
const ENTRY_KEYS = {
  name: true,
  cwd: true,
  sessionId: true,
  dir: true,
  writtenAt: true,
  titles: true,
  titleBytesFromEnd: true,
} satisfies Record<keyof TranscriptEntry, true>;

const recorded = ((): TranscriptFixture => {
  const read = fixture('transcripts') as TranscriptFixture;

  read.entries.forEach((entry, index) => {
    for (const key of Object.keys(ENTRY_KEYS)) {
      if (!Object.hasOwn(entry as object, key)) {
        throw new Error(`transcripts.json entry ${index} has no "${key}" — re-record it with record.js`);
      }
    }
  });

  return read;
})();

/**
 * Deliberately not the machine's own home: a reader ignoring its injected home would land on the real directory
 * and pass. Nothing exists here, so only a reader using what it was handed finds anything.
 */
export const HOME = '/nowhere/home';

const PROJECTS = `${HOME}/.claude/projects`;

export const transcripts: TranscriptFixture = { ...recorded, home: HOME };

export function config(over: Partial<SessionsConfig> = {}): SessionsConfig {
  return { agents: [{ id: 'claude', path: 'claude' }], branchIssuePattern: '^(\\d+)-', ...over };
}

/** Serves one recorded response and records the calls. A second call is a failure, not a repeat. */
export function runnerOf(response: unknown): ExecJson & { calls: [string, string[]][] } {
  const calls: [string, string[]][] = [];

  const run = (async (path: string, args: string[]): Promise<ExecOutcome> => {
    calls.push([path, args]);

    if (calls.length > 1) {
      throw new Error(`runner called ${calls.length} times but only one response was recorded`);
    }

    return { ok: true, value: response };
  }) as ExecJson & { calls: [string, string[]][] };

  run.calls = calls;

  return run;
}

type FailureReason = Exclude<ExecOutcome, { ok: true }>['reason'];

export function failingRunner(reason: FailureReason, detail = ''): ExecJson {
  return async () => ({ ok: false, reason, detail });
}

/** The recorded git reads, keyed by forward-slash path. An unrecorded path reads as absent, which is the truth. */
export function gitReads(): ReadText {
  const reads = fixture('git-reads') as Record<string, string | null>;

  return (path) => reads[path] ?? null;
}

/** The recorded listing, under a home only an injected reader can reach. */
export const listRecordedDirs: ListDir = (path) => (path === PROJECTS ? recorded.projectDirs : null);

/**
 * Keyed on the whole recorded path, directory included, so a wrong project directory reads as absent here exactly
 * as it would on disk.
 */
export const recordedMtimes: StatMtime = (path) => {
  const entry = recorded.entries.find((e) => e.dir !== null && path === `${PROJECTS}/${e.dir}/${e.sessionId}.jsonl`);

  return entry?.writtenAt ?? null;
};

/** What a positional read of a real transcript's end starts with: the back half of whatever line it cut through. */
const CUT_LINE = 'pe":"text","text":"...the rest of a message the read cut through"}]}}';

/** A conversation line that holds the word and parses, so the reader's cheap prefilter is not the only thing tested. */
const DECOY = JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'I will set the title of the report next.' }] },
});

/** Filler standing in for the conversation between title records, so the records do not all sit at the very end. */
const FILLER = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(2000) } });

/**
 * Each recorded transcript's tail, rebuilt from its recorded title records. The conversation bytes around them name
 * real work and so are not recorded; what the reader has to cope with is preserved — the records, their order, the
 * fragment a positional read leaves at the front, filler between and after them, and a line holding the word
 * `title` without being a record.
 */
export const readRecordedTails: ReadTail = (path, bytes) => {
  const entry = recorded.entries.find((e) => e.dir !== null && path === `${PROJECTS}/${e.dir}/${e.sessionId}.jsonl`);

  if (!entry) {
    return null;
  }

  const lines = [CUT_LINE, DECOY];

  for (const title of entry.titles) {
    lines.push(FILLER, JSON.stringify(title));
  }

  lines.push(FILLER, DECOY);

  return lines.join('\n').slice(-bytes);
};

/** What a reader must resolve for a recorded session: the developer's own title, else the agent's. */
export function expectedTitle(entry: TranscriptEntry): string | null {
  const last = (type: TitleRecord['type']): string | null => {
    const found = [...entry.titles].reverse().find((title) => title.type === type);

    return found?.customTitle ?? found?.aiTitle ?? null;
  };

  return last('custom-title') ?? last('ai-title');
}

/** The real Claude adapter wired to a recorded transport, which is what an adapter-owned transport makes possible. */
export function claudeWith(run: ExecJson): readonly AgentAdapter[] {
  return [makeClaudeAdapter(run)];
}

/** The recorded machine: git reads, transcript listing, write times and tails, under the synthetic home. */
export function recordedReaders(): MachineReaders {
  return { readText: gitReads(), mtime: recordedMtimes, listDir: listRecordedDirs, readTail: readRecordedTails, readHead: () => null, home: HOME };
}
