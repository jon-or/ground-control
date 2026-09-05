import { z } from 'zod';
import { basename, issueNumberFrom, repositoryOf } from '@ground-control/core';
import type { HistoricalSession, HistoryReading, MachineDeps } from '@ground-control/core';

const WINDOW_BYTES = 64 * 1024;
const SESSION_FILE = /^([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\.jsonl$/i;
const record = z.object({
  sessionId: z.string(),
  type: z.string(),
  isSidechain: z.boolean().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  customTitle: z.string().optional(),
  aiTitle: z.string().optional(),
});

interface Metadata { cwd: string; branch: string | null; title: string | null }

/** Bounded reads can begin or end inside a JSON line; only complete records for this parent session count. */
export function historyMetadata(head: string, tail: string, sessionId: string): Metadata | null {
  let cwd: string | null = null;
  let branch: string | null = null;
  let manual: string | null = null;
  let automatic: string | null = null;
  let prompted = false;
  for (const line of `${head}\n${tail}`.split('\n')) {
    let parsed;
    try { parsed = record.safeParse(JSON.parse(line)); } catch { continue; }
    if (!parsed.success || parsed.data.sessionId !== sessionId || parsed.data.isSidechain) continue;
    const r = parsed.data;
    if (r.type === 'user' || r.type === 'assistant') {
      prompted = true;
      cwd = r.cwd?.trim() || cwd;
      if (r.gitBranch !== undefined) branch = r.gitBranch.trim() || null;
    }
    if (r.type === 'custom-title') manual = r.customTitle?.trim() || manual;
    if (r.type === 'ai-title') automatic = r.aiTitle?.trim() || automatic;
  }
  return prompted && cwd ? { cwd, branch, title: manual ?? automatic } : null;
}

/** Metadata is cached by absolute transcript path and mtime. Every roster refresh still discovers additions/deletions. */
export function makeHistoryReader(): (deps: MachineDeps) => Promise<HistoryReading> {
  const cache = new Map<string, { at: number; metadata: Metadata | null }>();
  return async (deps) => {
    const root = `${deps.home.replace(/\\/g, '/').replace(/\/$/, '')}/.claude/projects`;
    const dirs = deps.listDir(root);
    const seen = new Set<string>();
    const sessions: HistoricalSession[] = [];
    let unreadable = false;
    // An agent that has never saved a project has no history. A present but unreadable projects directory is a failure.
    if (dirs === null) unreadable = deps.listDir(root.slice(0, -'/projects'.length))?.includes('projects') ?? false;
    const repositories = new Map<string, string | null>();
    for (const dir of dirs ?? []) {
      // A cold scan can span hundreds of transcripts; let live snapshots and hook events reach the hub between projects.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const directory = `${root}/${dir}`;
      const files = deps.listDir(directory);
      // Files can also live directly under projects; only project directories hold sessions.
      if (files === null) {
        if (deps.mtime(directory) === null) unreadable = true;
        continue;
      }
      for (const file of files) {
        const sessionId = SESSION_FILE.exec(file)?.[1];
        if (!sessionId) continue;
        const path = `${directory}/${file}`;
        seen.add(path);
        const at = deps.mtime(path);
        if (at === null) { unreadable = true; continue; }
        let held = cache.get(path);
        if (!held || held.at !== at) {
          const head = deps.readHead(path, WINDOW_BYTES);
          const tail = deps.readTail(path, WINDOW_BYTES);
          if (head === null || tail === null) { unreadable = true; continue; }
          held = { at, metadata: historyMetadata(head, tail, sessionId) };
          cache.set(path, held);
        }
        const m = held.metadata;
        if (!m) continue;
        if (!repositories.has(m.cwd)) repositories.set(m.cwd, repositoryOf(m.cwd, deps.readText));
        sessions.push({
          agent: 'claude', sessionId, title: m.title, cwd: m.cwd, branch: m.branch,
          issueNumber: deps.pattern ? issueNumberFrom(m.branch, deps.pattern) ?? issueNumberFrom(basename(m.cwd), deps.pattern) : null,
          repository: repositories.get(m.cwd)!, updatedAt: at,
        });
      }
    }
    for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
    return {
      // An incomplete history cannot establish which attempt is newest.
      sessions: unreadable ? [] : sessions,
      failure: unreadable ? { subject: 'claude', kind: 'history-failed', message: 'Some Claude session history could not be read.', remedy: 'Refresh the board and check access to ~/.claude/projects.' } : null,
    };
  };
}
