import { describe, expect, it } from 'vitest';
import { readRoster, sessionIndexPathOf, threadNamesFrom } from '../src/roster.js';
import { HOOK_MARKER_VERSION, activityDirOf, markerPathOf } from '../src/hookScript.js';
import { HOME, machine } from './helpers.js';
import type { FakeMachine } from './helpers.js';

const NOW = 1_700_000_000_000;
const ALIVE = () => true;
const DEAD = () => false;

interface Written {
  sessionId?: string;
  event?: string;
  pid?: number | null;
  cwd?: string | null;
  transcriptPath?: string | null;
  model?: string | null;
  turnAt?: number | null;
}

function markerText(over: Written = {}): string {
  return JSON.stringify({
    v: HOOK_MARKER_VERSION,
    sessionId: 'thread-1',
    event: 'PostToolUse',
    at: NOW,
    turnAt: NOW - 20_000,
    turnId: 'turn-1',
    pid: 4242,
    startedAt: NOW - 60_000,
    cwd: '/work/15619-a-branch',
    transcriptPath: '/rollout.jsonl',
    model: 'gpt-6-astra',
    permissionMode: 'default',
    source: null,
    toolName: 'Bash',
    reason: null,
    ...over,
  });
}

/** A checkout on disk: `linkOf` walks up from the session's own directory to find one. */
function checkout(files: Record<string, string>): Record<string, string> {
  return {
    '/work/15619-a-branch/.git': 'gitdir: /work/.git/worktrees/a',
    '/work/.git/worktrees/a/HEAD': 'ref: refs/heads/15619-a-branch\n',
    '/work/.git/worktrees/a/commondir': '../..\n',
    '/work/.git/config': '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n',
    ...files,
  };
}

function board(over: Partial<FakeMachine> = {}) {
  return machine({
    dirs: { [activityDirOf(HOME)]: ['thread-1.json'], ...over.dirs },
    files: checkout({ [markerPathOf(HOME, 'thread-1')]: markerText(), ...over.files }),
    ...(over.mtimes ? { mtimes: over.mtimes } : {}),
  });
}

describe('the roster the markers make', () => {
  it('reports a session whose Codex process is still running', () => {
    const reading = readRoster(board({ mtimes: { '/rollout.jsonl': 1_234 } }), ALIVE, {}, NOW);

    expect(reading.failure).toBeNull();
    expect(reading.sessions).toHaveLength(1);

    const [session] = reading.sessions;

    expect(session).toMatchObject({
      agent: 'codex',
      sessionId: 'thread-1',
      pid: 4242,
      cwd: '/work/15619-a-branch',
      checkoutRoot: '/work/15619-a-branch',
      branch: '15619-a-branch',
      repository: 'github.com/acme/widgets',
      issueNumber: 15619,
      startedAt: NOW - 60_000,
      transcriptWrittenAt: 1_234,
      finished: false,
      attachId: null,
    });
    expect(session?.activity).toEqual({ phase: 'running', since: NOW - 20_000, at: NOW, event: 'PostToolUse' });
    expect(session?.details).toEqual({ model: 'gpt-6-astra', permissionMode: 'default' });
  });

  it('excludes markers for terminated processes', () => {
    const reading = readRoster(board(), DEAD, {}, NOW);

    expect(reading.sessions).toEqual([]);
    expect(reading.failure).toBeNull();
  });

  it('takes the session title from the thread names Codex has written', () => {
    const reading = readRoster(
      board({
        files: {
          [sessionIndexPathOf(HOME)]: `${JSON.stringify({ id: 'thread-1', thread_name: 'Plan the history read' })}\n`,
        },
      }),
      ALIVE,
      {},
      NOW,
    );

    expect(reading.sessions[0]?.title).toBe('Plan the history read');
  });

  it('reports no title for a thread Codex has not named', () => {
    expect(readRoster(board(), ALIVE, {}, NOW).sessions[0]?.title).toBeNull();
  });

  it('returns no sessions before hook installation', () => {
    expect(readRoster(machine({}), ALIVE, {}, NOW)).toEqual({ sessions: [], failure: null });
  });

  it('skips the temporary file a write in flight leaves beside a marker', () => {
    const reading = readRoster(
      board({ dirs: { [activityDirOf(HOME)]: ['thread-1.json', 'thread-1.json.998.tmp'] } }),
      ALIVE,
      {},
      NOW,
    );

    expect(reading.sessions).toHaveLength(1);
    expect(reading.failure).toBeNull();
  });

  it('reports unreadable markers', () => {
    const reading = readRoster(
      board({
        dirs: { [activityDirOf(HOME)]: ['thread-1.json', 'thread-2.json'] },
        files: checkout({
          [markerPathOf(HOME, 'thread-1')]: markerText(),
          [markerPathOf(HOME, 'thread-2')]: '{ not json',
        }),
      }),
      ALIVE,
      {},
      NOW,
    );

    expect(reading.sessions).toHaveLength(1);
    expect(reading.failure?.kind).toBe('bad-response');
    expect(reading.failure?.message).toContain('1 Codex session marker');
  });

  it('reports a marker with no directory as unreadable, because a card cannot be placed without one', () => {
    const reading = readRoster(
      board({ files: checkout({ [markerPathOf(HOME, 'thread-1')]: markerText({ cwd: null }) }) }),
      ALIVE,
      {},
      NOW,
    );

    expect(reading.sessions).toEqual([]);
    expect(reading.failure?.message).toContain('could not be read');
  });

  it('reports missing marker PIDs', () => {
    const reading = readRoster(
      board({ files: checkout({ [markerPathOf(HOME, 'thread-1')]: markerText({ pid: null }) }) }),
      ALIVE,
      {},
      NOW,
    );

    expect(reading.sessions).toEqual([]);
    expect(reading.failure?.message).toContain('cannot tell whether 1 Codex session is still running');
  });

  it('reports no transcript time where the marker has no transcript path', () => {
    const reading = readRoster(
      board({ files: checkout({ [markerPathOf(HOME, 'thread-1')]: markerText({ transcriptPath: null }) }) }),
      ALIVE,
      {},
      NOW,
    );

    expect(reading.sessions[0]?.transcriptWrittenAt).toBeNull();
  });
});

describe('multiple invalid markers', () => {
    it('counts them, and names the unreadable ones before the unprovable', () => {
      const reading = readRoster(
        board({
          dirs: { [activityDirOf(HOME)]: ['thread-1.json', 'thread-2.json', 'thread-3.json'] },
          files: checkout({
            [markerPathOf(HOME, 'thread-1')]: '{ not json',
            [markerPathOf(HOME, 'thread-2')]: markerText({ sessionId: 'thread-2', cwd: null }),
            [markerPathOf(HOME, 'thread-3')]: markerText({ sessionId: 'thread-3', pid: null }),
          }),
        }),
        ALIVE,
        {},
        NOW,
      );

      expect(reading.sessions).toEqual([]);
      // A file the board cannot parse is the fault a reinstall fixes, so it is the one the board names first.
      expect(reading.failure?.message).toContain('2 Codex session markers');
    });

    it('pluralizes counts of sessions with unknown liveness', () => {
      const reading = readRoster(
        board({
          dirs: { [activityDirOf(HOME)]: ['thread-1.json', 'thread-2.json'] },
          files: checkout({
            [markerPathOf(HOME, 'thread-1')]: markerText({ pid: null }),
            [markerPathOf(HOME, 'thread-2')]: markerText({ sessionId: 'thread-2', pid: null }),
          }),
        }),
        ALIVE,
        {},
        NOW,
      );

      expect(reading.failure?.message).toContain('whether 2 Codex sessions are still running');
    });
  });

describe('the thread names index', () => {
  it('keeps the last name for an id and ignores lines it cannot parse', () => {
    const names = threadNamesFrom(
      ['{ not json', JSON.stringify({ id: 'a', thread_name: 'First' }), JSON.stringify({ id: 'a', thread_name: 'Renamed' }), ''].join('\n'),
    );

    expect(names.get('a')).toBe('Renamed');
    expect(names.size).toBe(1);
  });

  it('ignores an entry with no name, and reads an absent index as no names', () => {
    expect(threadNamesFrom(JSON.stringify({ id: 'a', thread_name: '  ' }))).toEqual(new Map());
    expect(threadNamesFrom(null)).toEqual(new Map());
  });

  it('ignores a line that is JSON but not an index entry', () => {
    expect(threadNamesFrom(JSON.stringify({ thread_name: 'no id here' }))).toEqual(new Map());
  });

  it('reads the session index under CODEX_HOME', () => {
    expect(sessionIndexPathOf(HOME, { CODEX_HOME: 'd:/elsewhere/codex' })).toBe('d:/elsewhere/codex/session_index.jsonl');
    expect(sessionIndexPathOf(HOME)).toBe(`${HOME}/.codex/session_index.jsonl`);
  });
});
