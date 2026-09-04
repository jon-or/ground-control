import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

/**
 * The run's two directories are minted by `test-integration/run.mjs`, which starts this and outlives the window it
 * opens. They cannot be minted here: this file is evaluated inside the run, so nothing here is left to stop the hub
 * the window started, or to remove the home it holds open.
 */
const home = process.env.GC_TEST_HOME;
const profile = process.env.GC_TEST_PROFILE;

if (!home || !profile) {
  throw new Error('Run the integration suite with `npm run test:integration`, which mints the run its own home.');
}

export default defineConfig({
  label: 'integration',
  files: 'test-integration/**/*.test.cjs',
  workspaceFolder: './test-integration/workspace',
  launchArgs: [`--user-data-dir=${profile}`, `--extensions-dir=${join(profile, 'extensions')}`],
  // `USERPROFILE` and `HOME` because the extension reads `os.homedir()`: a run against the developer's own would
  // rewrite the lane placements and agent settings of the board they are actually using.
  env: { USERPROFILE: home, HOME: home, GC_TEST_HOME: home },
  mocha: { timeout: 60_000, ui: 'bdd' },
});
