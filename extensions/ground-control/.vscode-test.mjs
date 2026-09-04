import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

/**
 * What earlier runs left. Its own two directories are still held by VS Code as a run ends, so each run clears the
 * ones before it: without this they accumulate one home and one profile per invocation, forever.
 */
function sweepOldRuns(olderThanMs = 60 * 60 * 1000) {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('gc-vscode-')) {
      continue;
    }

    const path = join(tmpdir(), name);

    try {
      if (Date.now() - statSync(path).mtimeMs > olderThanMs) {
        rmSync(path, { recursive: true, force: true, maxRetries: 2 });
      }
    } catch {
      // Another run holds it, or it went while this loop was reading. Either way the next run takes it.
    }
  }
}

sweepOldRuns();

/**
 * A home of the test's own, because the extension reads `os.homedir()`: a run against the developer's would rewrite
 * the lane placements and the agent settings of the board they are actually using.
 */
const home = mkdtempSync(join(tmpdir(), 'gc-vscode-home-'));

/**
 * And a VS Code profile of its own, per run. The default is one directory under `.vscode-test/`, which two runs at
 * once share: the second hands its arguments to the first instance and exits, and the settings each writes are the
 * other's to read. Reviews run in parallel, so two runs at once is the normal case rather than the odd one.
 */
const profile = mkdtempSync(join(tmpdir(), 'gc-vscode-profile-'));

/**
 * No network in tests. The board's only outbound calls are the two CLIs, so both are pointed at commands that are
 * not on any PATH: a bare name passes the spawn check and then fails to run, which is how an unconfigured machine
 * fails — offline, deterministic, and never against the developer's own GitHub token. Written here rather than in
 * the workspace because every setting the hub reads is application-scoped, which a workspace file cannot set (R9).
 */
mkdirSync(join(profile, 'User'), { recursive: true });
writeFileSync(
  join(profile, 'User', 'settings.json'),
  JSON.stringify(
    {
      'groundControl.github.ghPath': 'gh-not-on-this-path',
      'groundControl.github.repo': 'example-org/example-repo',
      'groundControl.github.logins': 'example-developer',
      'groundControl.agents': { claude: 'claude-not-on-this-path' },
      'window.newWindowProfile': 'Default',
    },
    null,
    2,
  ),
);

export default defineConfig({
  label: 'integration',
  files: 'test-integration/**/*.test.cjs',
  workspaceFolder: './test-integration/workspace',
  launchArgs: [`--user-data-dir=${profile}`, `--extensions-dir=${join(profile, 'extensions')}`],
  env: { USERPROFILE: home, HOME: home, GC_TEST_HOME: home },
  mocha: { timeout: 60_000, ui: 'bdd' },
});
