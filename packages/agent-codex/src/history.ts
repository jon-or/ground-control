import { z } from 'zod';
import { basename, issueNumberFrom, repositoryKey, repositoryOf } from '@ground-control/core';
import type { HistoricalSession, HistoryReading, MachineDeps } from '@ground-control/core';
import { CODEX_AGENT_ID, CODEX_DISPLAY_NAME } from './ids.js';
import { codexHomeOf } from './hookScript.js';
import { sessionIndexPathOf, threadNamesFrom } from './roster.js';

/**
 * Read up to three times the largest measured session_meta record. Instructions made these records 8–78 kB
 * across fifteen rollouts (M42).
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
  return `${codexHomeOf(home, env).replace(/\/$/, '')}/sessions`;
}

export interface RolloutMetadata {
  cwd: string;
  /** Branch recorded at session start; it may differ from the current checkout branch. */
  branch: string | null;
  repositoryUrl: string | null;
}

/**
 * Read saved session metadata. Return null for a nonmatching first record, or truncated when the read limit
 * cuts it short. Only truncation indicates a read failure.
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
 * Discover saved threads from rollout files. session_index.jsonl contains titles for named threads only (M42).
 * Cache metadata by path and mtime while checking for new files each read.
 */
export function makeHistoryReader(environment: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv) = {}): (deps: MachineDeps) => Promise<HistoryReading> {
  const cache = new Map<string, { at: number; metadata: RolloutMetadata | null }>();

  return async (deps) => {
    const env = typeof environment === 'function' ? { ...environment() } : { ...environment };
    const root = sessionsRootOf(deps.home, env);
    const days = dayDirectories(root, deps);
    const titles = threadNamesFrom(deps.readText(sessionIndexPathOf(deps.home, env)));
    const seen = new Set<string>();
    const sessions: HistoricalSession[] = [];
    let unreadable = false;

    // An absent sessions directory means no history; an unreadable home is a failure.
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

          // Do not cache truncated records, which would exclude sessions from history until hub restart.
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
          // Prefer the checkout remote used for card identity; fall back to the saved URL for deleted
          // checkouts.
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
 * Check for the rollout required to resume a thread. Its original checkout directory does not constrain where
 * it can open (M44).
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
