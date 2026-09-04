import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs the integration suite and owns what it leaves behind. The suite cannot clean up after itself: the window is
 * still a client while its own hooks run, so a hub stopped from inside is replaced by the reconnect a second later.
 * This process outlives the window, which is the only place the last word can be said.
 */
const HOME_PREFIX = 'gc-vscode-home-';
const PROFILE_PREFIX = 'gc-vscode-profile-';

/** What earlier runs left. A crashed run's hub holds its home open, so the process goes before the directory does. */
function sweep(olderThanMs = 60 * 60 * 1000) {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(HOME_PREFIX) && !name.startsWith(PROFILE_PREFIX)) {
      continue;
    }

    const path = join(tmpdir(), name);

    try {
      if (Date.now() - statSync(path).mtimeMs > olderThanMs) {
        stopHubIn(path);
        rmSync(path, { recursive: true, force: true, maxRetries: 2 });
      }
    } catch {
      // Another run holds it, or it went while this loop was reading. Either way a later run takes it.
    }
  }
}

/** Windows has no signal that reaches a console-less process (`docs/mechanics.md` §25), so this is what takes one. */
function stopHubIn(home) {
  try {
    process.kill(JSON.parse(readFileSync(join(home, '.claude', 'ground-control', 'hub.json'), 'utf8')).pid);
  } catch {
    // No record, no such process, or one that has already gone.
  }
}

sweep();

const home = mkdtempSync(join(tmpdir(), HOME_PREFIX));
const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));

/**
 * No network in tests. The board's only outbound calls are the two CLIs, so both are pointed at commands that are
 * not on any PATH: a bare name passes the spawn check and then fails to run, which is how an unconfigured machine
 * fails — offline, deterministic, and never against the developer's own GitHub token. Written to the profile rather
 * than the workspace because every setting the hub reads is application-scoped, which a workspace file cannot set.
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

const child = spawn('npx', ['vscode-test'], {
  cwd: process.cwd(),
  env: { ...process.env, GC_TEST_HOME: home, GC_TEST_PROFILE: profile },
  stdio: 'inherit',
  shell: true,
});

child.on('exit', (code) => {
  // The window has gone, so nothing is left to start another hub. Now the last one can be taken for good.
  stopHubIn(home);

  for (const path of [home, profile]) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // Still held by something on its way out. The next run's sweep takes it.
    }
  }

  process.exit(code ?? 1);
});
