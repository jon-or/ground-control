import { describe, expect, it } from 'vitest';
import { makeGhRunner } from '../src/index.js';

/** These spawn a local process, never the network. `node -e` stands in for gh so stderr and exit code are ours to set. */
function fakeGh(script: string) {
  const runner = makeGhRunner(process.execPath);

  return () => runner(['-e', script]);
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
