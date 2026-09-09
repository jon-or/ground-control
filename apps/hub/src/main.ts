import { homedir } from 'node:os';
import {
  BROWSERS,
  bundlePathOf,
  chromeHostPlan,
  installChromeHost,
  makeLogger,
  parseBrowsers,
  realChromeHostDeps,
  serveHub,
  stopHub,
  uninstallAgentActivity,
  uninstallChromeHost,
} from '@ground-control/hub';
import type { Browser } from '@ground-control/hub';
import { resolveStateDir } from '@ground-control/core';
import type { Logger } from '@ground-control/core';
import { startBridge } from './bridgeMain.js';
import { VERSION } from './version.js';

/**
 * Hub entry point: parse arguments, select a mode, and report its result. Business logic belongs in
 * `@ground-control/hub`.
 */
function flag(argv: readonly string[], name: string): string | null {
  const match = argv.find((argument) => argument === `--${name}` || argument.startsWith(`--${name}=`));

  if (match === undefined) {
    return null;
  }

  return match.includes('=') ? match.slice(match.indexOf('=') + 1) : '';
}

async function main(argv: readonly string[]): Promise<number> {
  const home = flag(argv, 'home') || homedir();
  const inheritAgentEnv = flag(argv, 'home') === null || flag(argv, 'inherit-agent-env') !== null;

  // The hub resolves the state directory itself when serving; commands resolve it here.
  const stateDir = (): string => resolveStateDir(home).stateDir;

  if (flag(argv, 'stop') !== null) {
    const stopped = await stopHub(stateDir());

    process.stdout.write(stopped ? 'Stopped the hub.\n' : 'No hub responded for this home directory.\n');

    return 0;
  }

  // Chrome starts the registered wrapper and closes stdin when the last board tab closes. The bridge keeps the
  // event loop open.
  if (flag(argv, 'native-messaging') !== null) {
    startBridge(home, inheritAgentEnv);

    return -1;
  }

  // --browsers=chrome,edge selects registrations; absent means Chrome. Uninstall removes every owned registration.
  const chrome = (browsers?: readonly Browser[]): ReturnType<typeof chromeHostPlan> =>
    chromeHostPlan({ platform: process.platform, home, bundle: bundlePathOf(home), node: process.execPath, ...(browsers ? { browsers } : {}) });
  const selection = parseBrowsers(flag(argv, 'browsers') ?? 'chrome');

  if (selection.unknown.length > 0) {
    process.stderr.write(`Unknown browser${selection.unknown.length === 1 ? '' : 's'} ${selection.unknown.join(', ')}; supported: ${BROWSERS.join(', ')}.\n`);

    return 1;
  }

  if (flag(argv, 'install-chrome-host') !== null) {
    try {
      process.stdout.write(`${installChromeHost(chrome(selection.browsers), realChromeHostDeps)}\n`);
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);

      return 1;
    }

    return 0;
  }

  if (flag(argv, 'uninstall-chrome-host') !== null) {
    try {
      process.stdout.write(`${uninstallChromeHost(chrome(selection.browsers), realChromeHostDeps)}\n`);
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);

      return 1;
    }

    return 0;
  }

  if (flag(argv, 'uninstall') !== null) {
    await stopHub(stateDir());
    const activity = uninstallAgentActivity(home, stateDir(), inheritAgentEnv ? process.env : undefined);
    if (activity.failure || activity.plan === 'busy') {
      process.stderr.write(`${activity.failure?.message ?? 'Activity settings are locked.'}\n`);
      return 1;
    }
    const browser = uninstallChromeHost(chrome(BROWSERS), realChromeHostDeps);
    process.stdout.write(`Removed the activity hooks and stopped the hub. ${browser}\n`);

    return 0;
  }

  // Allow short idle intervals for tests and manual checks.
  const idle = Number(flag(argv, 'idle-ms'));
  const result = await serveHub({
    home,
    ...(inheritAgentEnv ? { agentEnv: process.env } : {}),
    version: VERSION,
    // Reject nonpositive values and NaN, which would prevent idle shutdown and create a 1 ms timer.
    ...(idle > 0 ? { idleMs: idle } : {}),
  });

  if ('existing' in result) {
    process.stdout.write(`Hub already running for this home directory on port ${result.existing.record.port}.\n`);

    return 0;
  }

  if ('refused' in result) {
    process.stdout.write(`Not starting: ${result.refused}.\n`);

    return 0;
  }

  process.stdout.write(`Ground Control hub listening on 127.0.0.1:${result.served.port}.\n`);

  // These signals support foreground runs; Windows processes without a console do not receive them (M25).
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void result.served.stop(`received ${signal}`).then(() => process.exit(0)));
  }

  errorLog = result.served.log;

  return -1;
}

/** Use the hub logger after startup so crashes are recorded in `hub.log` as well as stderr. */
let errorLog: Logger = makeLogger({ write: () => {} });

function report(context: string, error: unknown): void {
  errorLog.error(`${context}: ${String(error)}`);
  process.stderr.write(`${context}: ${String(error)}\n`);
}

process.on('uncaughtException', (error) => {
  report('uncaughtException', error);
  process.exit(1);
});

// Log rejected promises without exiting. Windows file locks can reject writes; exiting would also skip `stop()`
// cleanup.
process.on('unhandledRejection', (error) => report('unhandledRejection', error));

// The client bundles this entry point as CommonJS, which does not support top-level await.
void main(process.argv.slice(2))
  .then((code) => {
    // -1 keeps the server or bridge running. Other codes indicate completion.
    if (code >= 0) {
      process.exit(code);
    }
  })
  .catch((error: unknown) => {
    // Report command failures on stderr and exit nonzero so clients do not report a successful installation
    // (R34).
    report('Hub command failed', error);
    process.exit(1);
  });
