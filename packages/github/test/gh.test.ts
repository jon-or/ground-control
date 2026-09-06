import { describe, expect, it } from 'vitest';
import { makeGhRunner } from '../src/index.js';

/** These spawn a local process, never the network. `node -e` stands in for gh so stderr and exit code are ours to set. */
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

  // Recorded from gh 2.96.0 with an invalid GH_TOKEN: exit 1, and nothing in stderr mentions gh auth login.
  it('classifies an expired or revoked token as not-authenticated', async () => {
    const result = await fakeGh('console.error("gh: Bad credentials (HTTP 401)"); process.exit(1)')();

    expect(result.ok === false && result.error.kind).toBe('not-authenticated');
  });

  // The message on the board's own banner, recorded from gh 2.96.0 on a laptop whose network was not back yet.
  it('classifies a machine that cannot reach GitHub as offline, and says so in its own words', async () => {
    const stderr = 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com';
    const result = await fakeGh(`console.error(${JSON.stringify(stderr)}); process.exit(1)`)();

    expect(result.ok === false && result.error.kind).toBe('offline');
    expect(result.ok === false && result.error.transient).toBe(true);
    // gh's own stderr never reaches the board, and neither does an instruction to do anything: a board that is
    // already retrying must not be pointed at a refresh button or at the developer's own internet connection.
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
  it('classifies a read that ran out of time as transient, so the board rides it out rather than banners it', async () => {
    const result = await fakeGh('setInterval(() => undefined, 1000)', { timeoutMs: 200 })();

    expect(result.ok === false && result.error.kind).toBe('timed-out');
    expect(result.ok === false && result.error.transient).toBe(true);
    expect(result.ok === false && result.error.remedy).not.toMatch(/refresh|connection|check/i);
  });

  it('falls back to the spawn error when the process said nothing on stderr', async () => {
    const result = await fakeGh('process.exit(9)')();

    expect(result.ok === false && result.error.kind).toBe('query-failed');
    expect(result.ok === false && result.error.message.length).toBeGreaterThan(0);
  });

  it('classifies any other non-zero exit as query-failed, carrying stderr', async () => {
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
