import { z } from 'zod';
import { basename, issueNumberFrom, repositoryKey, repositoryOf } from '@ground-control/core';
import type { HistoricalSession, HistoryReading, MachineDeps } from '@ground-control/core';
import { CODEX_AGENT_ID, CODEX_DISPLAY_NAME } from './ids.js';
import { codexHomeOf } from './hookScript.js';
import { sessionIndexPathOf, threadNamesFrom } from './roster.js';

/**
 * Enough of a rollout's head to hold its first record whole. Codex writes the model's whole instruction text into
 * `session_meta`, which measured 8–78 kB across this machine's fifteen rollouts, so the bound is three times the
 * largest one seen rather than a round number near it (`docs/mechanics.md` M42).
 */
export const META_HEAD_BYTES = 256 * 1024;

const ROLLOUT_FILE = /^rollout-.+-([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\.jsonl$/i;

const meta = z.object({
  type: z.literal('session_meta'),
  payload: z.object({
    session_id: z.string(),
    cwd: z.string(),
    git: z
      .object({ branch: z.string().nullish(), repository_url: z.string().nullish() })
      .nullish(),
  }),
});

export function sessionsRootOf(home: string, env: NodeJS.ProcessEnv = {}): string {
  return `${codexHomeOf(home, env)}/sessions`;
}

export interface RolloutMetadata {
  cwd: string;
  /** The branch the session started on, which is the saved fact rather than the checkout's branch now. */
  branch: string | null;
  repositoryUrl: string | null;
}

/**
 * A rollout's saved directory and branch; `null` when its first record is not a `session_meta` for this session, and
 * `'truncated'` when the bounded read ended inside that record. The two are different answers — one is a file that
 * holds no session, the other a session the board could not read — and only the second is a failure to report.
 */
export function rolloutMetadata(head: string, sessionId: string): RolloutMetadata | 'truncated' | null {
  const end = head.indexOf('\n');

  if (end < 0) {
    return 'truncated';
  }

  let parsed;

  try {
    parsed = meta.safeParse(JSON.parse(head.slice(0, end)));
  } catch {
    return null;
  }

  if (!parsed.success || parsed.data.payload.session_id !== sessionId) {
    return null;
  }

  const { cwd, git } = parsed.data.payload;

  return cwd.trim()
    ? { cwd: cwd.trim(), branch: git?.branch?.trim() || null, repositoryUrl: git?.repository_url?.trim() || null }
    : null;
}

/** Every date directory under the sessions root, which Codex nests as `YYYY/MM/DD`. */
function dayDirectories(root: string, deps: MachineDeps): string[] | null {
  const years = deps.listDir(root);

  if (years === null) {
    return null;
  }

  const days: string[] = [];

  for (const year of years) {
    for (const month of deps.listDir(`${root}/${year}`) ?? []) {
      for (const day of deps.listDir(`${root}/${year}/${month}`) ?? []) {
        days.push(`${root}/${year}/${month}/${day}`);
      }
    }
  }

  return days;
}

/**
 * Saved Codex threads, read from the rollout files themselves rather than from `session_index.jsonl` — the index
 * holds only threads Codex has named, five of the twenty on this machine, so it is the title source and not the
 * roster (`docs/mechanics.md` M42). Metadata is cached by path and mtime; every read still finds additions.
 */
export function makeHistoryReader(env: NodeJS.ProcessEnv = {}): (deps: MachineDeps) => Promise<HistoryReading> {
  const cache = new Map<string, { at: number; metadata: RolloutMetadata | null }>();

  return async (deps) => {
    const root = sessionsRootOf(deps.home, env);
    const days = dayDirectories(root, deps);
    const titles = threadNamesFrom(deps.readText(sessionIndexPathOf(deps.home, env)));
    const seen = new Set<string>();
    const sessions: HistoricalSession[] = [];
    let unreadable = false;

    // An agent that has never saved a session has no history. A home that will not list is not that claim, so an
    // unreadable one is a failure rather than silence.
    if (days === null) {
      const held = deps.listDir(codexHomeOf(deps.home, env));

      unreadable = held === null || held.includes('sessions');
    }

    const repositories = new Map<string, string | null>();

    for (const day of days ?? []) {
      // A cold scan can span hundreds of rollouts; let live snapshots and hook events reach the hub between days.
      await new Promise<void>((resolve) => setImmediate(resolve));

      const files = deps.listDir(day);

      if (files === null) {
        unreadable = true;
        continue;
      }

      for (const file of files) {
        const sessionId = ROLLOUT_FILE.exec(file)?.[1];

        if (!sessionId) {
          continue;
        }

        const path = `${day}/${file}`;
        seen.add(path);
        const at = deps.mtime(path);

        if (at === null) {
          unreadable = true;
          continue;
        }

        let held = cache.get(path);

        if (!held || held.at !== at) {
          const head = deps.readHead(path, META_HEAD_BYTES);
          const found = head === null ? 'truncated' : rolloutMetadata(head, sessionId);

          // Not cached: a record too long for the bound is the board's own limit, and caching the miss would hold
          // this session out of history for the life of the hub.
          if (found === 'truncated') {
            unreadable = true;
            continue;
          }

          held = { at, metadata: found };
          cache.set(path, held);
        }

        const found = held.metadata;

        if (!found) {
          continue;
        }

        if (!repositories.has(found.cwd)) {
          // The checkout's own remote first, because that is what a card is keyed on. The saved URL answers for a
          // checkout that has since been deleted, which is the case a saved session is most likely to be in.
          repositories.set(found.cwd, repositoryOf(found.cwd, deps.readText) ?? repositoryKey(found.repositoryUrl ?? ''));
        }

        sessions.push({
          agent: CODEX_AGENT_ID,
          sessionId,
          title: titles.get(sessionId) ?? null,
          cwd: found.cwd,
          branch: found.branch,
          issueNumber: deps.pattern
            ? issueNumberFrom(found.branch, deps.pattern) ?? issueNumberFrom(basename(found.cwd), deps.pattern)
            : null,
          repository: repositories.get(found.cwd) ?? null,
          updatedAt: at,
        });
      }
    }

    for (const path of cache.keys()) {
      if (!seen.has(path)) {
        cache.delete(path);
      }
    }

    return {
      // An incomplete history cannot establish which attempt is newest.
      sessions: unreadable ? [] : sessions,
      failure: unreadable
        ? {
            subject: CODEX_AGENT_ID,
            kind: 'history-failed',
            message: `Some ${CODEX_DISPLAY_NAME} session history could not be read.`,
            remedy: 'Refresh the board and check access to ~/.codex/sessions.',
          }
        : null,
    };
  };
}

/**
 * Whether Codex still holds this thread's rollout. What a resume turns on: a thread is opened by its id alone, and
 * the directory it once ran in does not constrain where it can be opened (`docs/mechanics.md` M44) — so the saved
 * checkout is not the question, and the file Codex would read is.
 */
export function rolloutExists(sessionId: string, deps: MachineDeps, env: NodeJS.ProcessEnv = {}): boolean {
  const root = sessionsRootOf(deps.home, env);

  for (const day of dayDirectories(root, deps) ?? []) {
    const found = (deps.listDir(day) ?? []).some((file) => ROLLOUT_FILE.exec(file)?.[1] === sessionId);

    if (found) {
      return true;
    }
  }

  return false;
}
