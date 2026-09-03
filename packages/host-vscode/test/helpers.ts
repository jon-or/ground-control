import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Session } from '@ground-control/core';

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));
}

/**
 * Whole, not cast: a partial literal would go on compiling the day `Session` grows a field, and every decision here
 * is about where a session is held rather than what it carries, so a built row is as good as a recorded one.
 */
export function session(over: Partial<Session> = {}): Session {
  return {
    agent: 'claude',
    sessionId: 'a1b2c3d4-0000-4000-8000-000000000000',
    pid: 4242,
    shortId: null,
    name: null,
    title: 'the session',
    cwd: 'd:/work/repo.worktrees/18941-inbox-badge-overwrites-a-manual-edit',
    kind: 'interactive',
    startedAt: 1_788_000_000_000,
    status: null,
    state: null,
    branch: '18941-inbox-badge-overwrites-a-manual-edit',
    issueNumber: 18941,
    transcriptWrittenAt: null,
    activity: null,
    ...over,
  };
}
