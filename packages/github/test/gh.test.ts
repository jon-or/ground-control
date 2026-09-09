import { describe, expect, it } from 'vitest';
import { makeGhRunner } from '../src/index.js';
import type { LogEntry, Logger } from '@ground-control/core';

/** Use node -e instead of gh to control process output without network requests. */
function fakeGh(script: string, options?: { timeoutMs: number }) {
  const runner = makeGhRunner(process.execPath);

  return () => runner(['-e', script], options);
}

describe('makeGhRunner', () => {
  it('classifies a missing binary as gh-missing', async () => {
    const result = await makeGhRunner('gh-does-not-exist-here')(['--version']);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.kind).toBe('gh-missing');
    expect(result.ok === false && result.error.remedy).toContain('Install the GitHub CLI');
  });

  it('classifies a logged-out CLI as not-authenticated', async () => {
    const result = await fakeGh('console.error("gh: To get started with GitHub CLI, please run: gh auth login"); process.exit(1)')();

    expect(result.ok === false && result.error.kind).toBe('not-authenticated');
    expect(result.ok === false && result.error.remedy).toContain('gh auth login');
  });

  // Recorded gh 2.96.0 invalid-token error: exit 1 without gh auth login in stderr.
  it('classifies an expired or revoked token as not-authenticated', async () => {
    const result = await fakeGh('console.error("gh: Bad credentials (HTTP 401)"); process.exit(1)')();

    expect(result.ok === false && result.error.kind).toBe('not-authenticated');
  });

  // Recorded gh 2.96.0 network error after laptop resume.
  it('classifies network failures as offline', async () => {
    const stderr = 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com';
    const result = await fakeGh(`console.error(${JSON.stringify(stderr)}); process.exit(1)`)();

    expect(result.ok === false && result.error.kind).toBe('offline');
    expect(result.ok === false && result.error.transient).toBe(true);
    // Report automatic retry without exposing raw stderr or requesting manual refresh.
    expect(result.ok === false && result.error.message).not.toContain('githubstatus');
    expect(result.ok === false && result.error.remedy).not.toMatch(/refresh|connection|check/i);
  });

  it.each([
    'dial tcp: lookup api.github.com: no such host',
    'dial tcp 140.82.121.6:443: connectex: A socket operation was attempted to an unreachable network.',
    'Post "https://api.github.com/graphql": net/http: TLS handshake timeout',
    'Get "https://api.github.com/graphql": context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
  ])('classifies %s as offline', async (stderr) => {
    const result = await fakeGh(`console.error(${JSON.stringify(stderr)}); process.exit(1)`)();

    expect(result.ok === false && result.error.kind).toBe('offline');
  });

  /** The board only rides out what nobody can act on. A repository that is gone is not that, and neither is a 503. */
  it.each([
    'Could not resolve to a Repository with the name "example/nope".',
    'HTTP 503: Service unavailable (https://api.github.com/graphql)',
  ])('leaves %s as a failure the board states at once', async (stderr) => {
    const result = await fakeGh(`console.error(${JSON.stringify(stderr)}); process.exit(1)`)();

    expect(result.ok === false && result.error.kind).toBe('query-failed');
    expect(result.ok === false && result.error.transient).toBeUndefined();
  });

  /** A `gh` that never answers would otherwise hold the poll for the life of the hub, and every retry with it. */
  it('classifies timeouts as transient failures', async () => {
    const result = await fakeGh('setInterval(() => undefined, 1000)', { timeoutMs: 200 })();

    expect(result.ok === false && result.error.kind).toBe('timed-out');
    expect(result.ok === false && result.error.transient).toBe(true);
    expect(result.ok === false && result.error.remedy).not.toMatch(/refresh|connection|check/i);
  });

  it('uses the spawn error when stderr is empty', async () => {
    const result = await fakeGh('process.exit(9)')();

    expect(result.ok === false && result.error.kind).toBe('query-failed');
    expect(result.ok === false && result.error.message.length).toBeGreaterThan(0);
  });

  it('preserves stderr for other query failures', async () => {
    const result = await fakeGh('console.error("Could not resolve to a Repository"); process.exit(1)')();

    expect(result.ok === false && result.error.kind).toBe('query-failed');
    expect(result.ok === false && result.error.message).toContain('Could not resolve to a Repository');
  });

  it('classifies non-JSON output as bad-response rather than throwing', async () => {
    const result = await fakeGh('console.log("<html>not json</html>")')();

    expect(result.ok === false && result.error.kind).toBe('bad-response');
  });

  it('returns parsed JSON on success', async () => {
    const result = await fakeGh('console.log(JSON.stringify({data:{ok:true}}))')();

    expect(result.ok && result.value).toEqual({ data: { ok: true } });
  });
});

describe('what each call leaves in the log', () => {
  /** Capture all runner log calls without threshold filtering. */
  function capturing() {
    const entries: LogEntry[] = [];

    return {
      entries,
      log: {
        debug: (message: string, scope?: string) => entries.push({ at: '', level: 'debug', source: 'hub', message, ...(scope ? { scope } : {}) }),
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        setLevel: () => undefined,
        level: () => 'debug' as const,
        watch: () => () => undefined,
      } satisfies Logger,
    };
  }

  it('names the subcommand and how long it took, scoped to gh', async () => {
    const { log, entries } = capturing();
    const result = await makeGhRunner(process.execPath, log)(['-e', 'console.log(JSON.stringify({ok:true}))']);

    expect(result.ok).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.scope).toBe('gh');
    expect(entries[0]!.message).toMatch(/^-e console\.log\(JSON\.stringify\(\{ok:true\}\)\) in \d+ms$/);
  });

  // Log the classified kind; the caller reports detailed CLI errors.
  it('names the kind when a call fails, and does not repeat the CLI stderr', async () => {
    const { log, entries } = capturing();

    await makeGhRunner(process.execPath, log)(['-e', 'console.error("gh auth login"); process.exit(1)']);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toMatch(/failed after \d+ms: not-authenticated$/);
  });

  // One line per invocation is the whole point: a source read that pages is several calls behind one board line.
  it('writes one line per invocation rather than one per read', async () => {
    const { log, entries } = capturing();
    const run = makeGhRunner(process.execPath, log);

    await run(['-e', 'console.log("{}")']);
    await run(['-e', 'console.log("{}")']);
    await run(['-e', 'console.log("{}")']);

    expect(entries).toHaveLength(3);
  });

  // The refusal: no logger, no wrapper, and the runner is the object it always was.
  it('returns an unwrapped runner without a logger', async () => {
    const result = await makeGhRunner(process.execPath)(['-e', 'console.log("{}")']);

    expect(result.ok).toBe(true);
  });
});
