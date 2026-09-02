import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ExecJson, ExecOutcome } from '../src/providers/exec-json.js';
import { makeClaudeProvider } from '../src/providers/claude.js';
import type { ListDir, SessionProvider, StatMtime } from '../src/provider.js';
import type { ReadText } from '../src/link.js';
import type { SessionsConfig } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));
}

export interface TranscriptEntry {
  name: string | null;
  cwd: string;
  sessionId: string;
  /** The project directory the transcript was actually found in, which is not always the exact-case slug. */
  dir: string | null;
  writtenAt: number | null;
}

export interface TranscriptFixture {
  home: string;
  projectDirs: string[];
  entries: TranscriptEntry[];
}

const recorded = fixture('transcripts') as TranscriptFixture;

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

/** The real Claude provider wired to a recorded transport, which is what a provider-owned transport makes possible. */
export function claudeWith(run: ExecJson): readonly SessionProvider[] {
  return [makeClaudeProvider(run)];
}
