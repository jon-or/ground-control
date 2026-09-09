import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Clean up after VS Code exits so a connected client cannot restart the hub.
 */
const HOME_PREFIX = 'gc-vscode-home-';
const PROFILE_PREFIX = 'gc-vscode-profile-';

/** Stop stale test hubs before removing their temporary directories; running hubs can keep directories open. */
function removeStaleTestDirectories(olderThanMs = 60 * 60 * 1000) {
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

/** Force-terminate the recorded test hub; graceful signal handlers do not run on Windows (mechanics M25). */
function stopHubIn(home) {
  try {
    process.kill(JSON.parse(readFileSync(join(home, '.claude', 'ground-control', 'hub.json'), 'utf8')).pid);
  } catch {
    // No record, no such process, or one that has already gone.
  }
}

removeStaleTestDirectories();

const home = mkdtempSync(join(tmpdir(), HOME_PREFIX));
const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));

/**
 * Use unavailable CLI commands to prevent network access and use of developer credentials, including GitHub
 * credentials stored outside the isolated home.
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
      // A process still has the directory open. A later run retries removal.
    }
  }

  process.exit(code ?? 1);
});
