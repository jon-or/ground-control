import { describe, expect, it } from 'vitest';
import { makeHistoryReader, rolloutExists, rolloutMetadata, sessionsRootOf } from '../src/history.js';
import { sessionIndexPathOf } from '../src/roster.js';
import { HOME, machine } from './helpers.js';
import type { FakeMachine } from './helpers.js';

const ID = '01a072f9-c43a-73e2-a4fd-3a63e73ad152';
const ROOT = sessionsRootOf(HOME);
const FILE = `rollout-2026-09-05T15-09-26-${ID}.jsonl`;
const PATH = `${ROOT}/2026/09/05/${FILE}`;

/** The first line of a real rollout, trimmed to the fields the reader looks at (`docs/mechanics.md` §42). */
function meta(over: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    timestamp: '2026-09-05T19:10:51.441Z',
    type: 'session_meta',
    payload: {
      session_id: ID,
      id: ID,
      cwd: 'd:\\git\\15619-a-branch',
      originator: 'codex_vscode',
      cli_version: '0.153.0',
      source: 'vscode',
      git: { commit_hash: 'ca42bdd', branch: '15619-a-branch', repository_url: 'https://github.com/acme/widgets' },
      ...over,
    },
  })}\n{"type":"turn_context"}\n`;
}

function saved(over: Partial<FakeMachine> = {}) {
  return machine({
    dirs: {
      [`${HOME}/.codex`]: ['sessions', 'config.toml'],
      [ROOT]: ['2026'],
      [`${ROOT}/2026`]: ['09'],
      [`${ROOT}/2026/09`]: ['05'],
      [`${ROOT}/2026/09/05`]: [FILE],
      ...over.dirs,
    },
    files: { [PATH]: meta(), ...over.files },
    mtimes: { [PATH]: 5_000, ...over.mtimes },
  });
}

describe('reading one rollout head', () => {
  it('takes the directory and the branch the session started on', () => {
    expect(rolloutMetadata(meta(), ID)).toEqual({
      cwd: 'd:\\git\\15619-a-branch',
      branch: '15619-a-branch',
      repositoryUrl: 'https://github.com/acme/widgets',
    });
  });

  it('reports no branch for a session started outside a checkout', () => {
    expect(rolloutMetadata(meta({ git: null }), ID)).toEqual({
      cwd: 'd:\\git\\15619-a-branch',
      branch: null,
      repositoryUrl: null,
    });
  });

  it('refuses a head whose first record belongs to another session', () => {
    expect(rolloutMetadata(meta({ session_id: 'someone-else' }), ID)).toBeNull();
  });

  it('names a head cut short of its first record, which is the board bound rather than a file with no session', () => {
    expect(rolloutMetadata(meta().slice(0, 40), ID)).toBe('truncated');
  });

  it('refuses a first record that is not a session_meta', () => {
    expect(rolloutMetadata('{"type":"turn_context"}\n', ID)).toBeNull();
  });
});

describe('the saved Codex sessions', () => {
  it('reports a rollout with its title, branch, repository, and issue number', async () => {
    const reading = await makeHistoryReader()(
      saved({
        files: {
          [sessionIndexPathOf(HOME)]: `${JSON.stringify({ id: ID, thread_name: 'Plan historical session display' })}\n`,
        },
      }),
    );

    expect(reading.failure).toBeNull();
    expect(reading.sessions).toEqual([
      {
        agent: 'codex',
        sessionId: ID,
        title: 'Plan historical session display',
        cwd: 'd:\\git\\15619-a-branch',
        branch: '15619-a-branch',
        issueNumber: 15619,
        repository: 'github.com/acme/widgets',
        updatedAt: 5_000,
      },
    ]);
  });

  it('takes the repository from the checkout on disk before the URL the session saved', async () => {
    const reading = await makeHistoryReader()(
      saved({
        files: {
          'd:/git/15619-a-branch/.git': 'gitdir: d:/git/.git/worktrees/a',
          'd:/git/.git/worktrees/a/HEAD': 'ref: refs/heads/moved-on\n',
          'd:/git/.git/worktrees/a/commondir': '../..\n',
          'd:/git/.git/config': '[remote "origin"]\n\turl = git@github.com:acme/moved.git\n',
        },
      }),
    );

    expect(reading.sessions[0]?.repository).toBe('github.com/acme/moved');
    // The branch stays the one the session ran on, which is the saved fact rather than the checkout now.
    expect(reading.sessions[0]?.branch).toBe('15619-a-branch');
  });

  it('has no history for an agent that has never saved a session', async () => {
    expect(await makeHistoryReader()(machine({ dirs: { [`${HOME}/.codex`]: ['config.toml'] } }))).toEqual({
      sessions: [],
      failure: null,
    });
  });

  it('reports a failure and no sessions when the sessions directory is there but unreadable', async () => {
    const reading = await makeHistoryReader()(machine({ dirs: { [`${HOME}/.codex`]: ['sessions'] } }));

    expect(reading.sessions).toEqual([]);
    expect(reading.failure?.kind).toBe('history-failed');
  });

  it('reports a failure when one rollout cannot be read', async () => {
    const reading = await makeHistoryReader()(
      saved({ dirs: { [`${ROOT}/2026/09/05`]: [FILE, `rollout-2026-09-06T00-00-00-${ID.replace('01a', '01b')}.jsonl`] } }),
    );

    expect(reading.sessions).toEqual([]);
    expect(reading.failure?.kind).toBe('history-failed');
  });

  it('ignores a file that is not a rollout', async () => {
    const reading = await makeHistoryReader()(saved({ dirs: { [`${ROOT}/2026/09/05`]: [FILE, 'notes.txt'] } }));

    expect(reading.sessions).toHaveLength(1);
    expect(reading.failure).toBeNull();
  });

  it('takes the issue number from the branch before the directory, and from the directory alone where it must', async () => {
    const fromBranch = await makeHistoryReader()(
      saved({ files: { [PATH]: meta({ cwd: 'd:\\git\\checkout', git: { branch: '15619-a-branch' } }) } }),
    );

    expect(fromBranch.sessions[0]?.issueNumber).toBe(15619);

    const fromDirectory = await makeHistoryReader()(
      saved({ files: { [PATH]: meta({ cwd: 'd:\\git\\204-elsewhere', git: null }) } }),
    );

    expect(fromDirectory.sessions[0]?.issueNumber).toBe(204);

    // The branch is the primary signal, so a disagreement is decided by it rather than by the directory name.
    const both = await makeHistoryReader()(
      saved({ files: { [PATH]: meta({ cwd: 'd:\\git\\204-elsewhere', git: { branch: '15619-a-branch' } }) } }),
    );

    expect(both.sessions[0]?.issueNumber).toBe(15619);
  });

  it('links no issue at all when the configured pattern is unusable', async () => {
    const unusable = machine(
      {
        dirs: {
          [`${HOME}/.codex`]: ['sessions'],
          [ROOT]: ['2026'],
          [`${ROOT}/2026`]: ['09'],
          [`${ROOT}/2026/09`]: ['05'],
          [`${ROOT}/2026/09/05`]: [FILE],
        },
        files: { [PATH]: meta() },
        mtimes: { [PATH]: 5_000 },
      },
      null,
    );
    const reading = await makeHistoryReader()(unusable);

    // The branch is still the saved fact; only the number it would have been read for is gone.
    expect(reading.sessions[0]?.branch).toBe('15619-a-branch');
    expect(reading.sessions[0]?.issueNumber).toBeNull();
  });

  it('reports a failure for a rollout whose first record is longer than the board reads', async () => {
    const long = `{"type":"session_meta","payload":{"session_id":"${ID}","cwd":"d:\\\\git\\\\x","instructions":"${'x'.repeat(300 * 1024)}"}}\n`;
    const reading = await makeHistoryReader()(saved({ files: { [PATH]: long } }));

    // Not silence: a record too long for the bound is the board's own limit, and a session it dropped without a word
    // would be a card that quietly lost its history.
    expect(reading.sessions).toEqual([]);
    expect(reading.failure?.kind).toBe('history-failed');
  });

  it('skips a rollout whose first record is not a session_meta without failing the read', async () => {
    const reading = await makeHistoryReader()(saved({ files: { [PATH]: '{"type":"turn_context"}\n' } }));

    expect(reading.sessions).toEqual([]);
    expect(reading.failure).toBeNull();
  });

  it('skips a session_meta with no working directory, which cannot be placed on a card', async () => {
    const reading = await makeHistoryReader()(saved({ files: { [PATH]: meta({ cwd: '   ' }) } }));

    expect(reading.sessions).toEqual([]);
    expect(reading.failure).toBeNull();
  });

  it('reports a failure when a day directory will not list', async () => {
    const reading = await makeHistoryReader()(
      machine({
        dirs: { [`${HOME}/.codex`]: ['sessions'], [ROOT]: ['2026'], [`${ROOT}/2026`]: ['09'], [`${ROOT}/2026/09`]: ['05'] },
      }),
    );

    expect(reading.failure?.kind).toBe('history-failed');
  });

  it('reports a failure when the Codex home itself will not list', async () => {
    const reading = await makeHistoryReader()(machine({}));

    expect(reading.failure?.kind).toBe('history-failed');
  });

  it('reads the home CODEX_HOME names rather than the one beside it', async () => {
    const moved = 'd:/elsewhere/codex';
    const reading = await makeHistoryReader({ CODEX_HOME: moved })(
      machine({
        dirs: {
          [`${moved}`]: ['sessions'],
          [`${moved}/sessions`]: ['2026'],
          [`${moved}/sessions/2026`]: ['09'],
          [`${moved}/sessions/2026/09`]: ['05'],
          [`${moved}/sessions/2026/09/05`]: [FILE],
        },
        files: { [`${moved}/sessions/2026/09/05/${FILE}`]: meta() },
        mtimes: { [`${moved}/sessions/2026/09/05/${FILE}`]: 5_000 },
      }),
    );

    expect(reading.sessions.map((session) => session.sessionId)).toEqual([ID]);
  });

  it('re-reads a rollout only when its modified time has moved', async () => {
    const read = makeHistoryReader();
    const reads: string[] = [];
    const deps = saved();
    const counted = { ...deps, readHead: (path: string, bytes: number) => (reads.push(path), deps.readHead(path, bytes)) };

    await read(counted);
    await read(counted);

    expect(reads).toEqual([PATH]);

    await read({ ...counted, mtime: (path) => (path === PATH ? 9_000 : deps.mtime(path)) });

    expect(reads).toEqual([PATH, PATH]);
  });
});

describe('whether a saved thread can still be opened', () => {
  it('finds the rollout Codex still holds', () => {
    expect(rolloutExists(ID, saved())).toBe(true);
  });

  it('refuses a thread whose rollout has gone, and one on a machine that has saved none', () => {
    expect(rolloutExists('01a07305-a7e9-7200-9307-4e8ecfb71158', saved())).toBe(false);
    expect(rolloutExists(ID, machine({}))).toBe(false);
  });

  it('looks in the home CODEX_HOME names', () => {
    const moved = 'd:/elsewhere/codex';
    const deps = machine({
      dirs: {
        [moved]: ['sessions'],
        [`${moved}/sessions`]: ['2026'],
        [`${moved}/sessions/2026`]: ['09'],
        [`${moved}/sessions/2026/09`]: ['05'],
        [`${moved}/sessions/2026/09/05`]: [FILE],
      },
    });

    expect(rolloutExists(ID, deps, { CODEX_HOME: moved })).toBe(true);
    expect(rolloutExists(ID, deps)).toBe(false);
  });
});
