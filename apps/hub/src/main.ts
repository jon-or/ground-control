import { homedir } from 'node:os';
import {
  bundlePathOf,
  chromeHostPlan,
  installChromeHost,
  makeLogger,
  makeRegistries,
  realChromeHostDeps,
  serveHub,
  stopHub,
  uninstallActivity,
  uninstallChromeHost,
} from '@ground-control/hub';
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

  if (flag(argv, 'stop') !== null) {
    const stopped = await stopHub(home);

    process.stdout.write(stopped ? 'Stopped the hub.\n' : 'No hub responded for this home directory.\n');

    return 0;
  }

  // Chrome starts the registered wrapper and closes stdin when the last board tab closes. The bridge keeps the
  // event loop open.
  if (flag(argv, 'native-messaging') !== null) {
    startBridge(home);

    return -1;
  }

  const chrome = (): ReturnType<typeof chromeHostPlan> =>
    chromeHostPlan({ platform: process.platform, home, bundle: bundlePathOf(home), node: process.execPath });

  if (flag(argv, 'install-chrome-host') !== null) {
    process.stdout.write(`${installChromeHost(chrome(), realChromeHostDeps)}\n`);

    return 0;
  }

  if (flag(argv, 'uninstall-chrome-host') !== null) {
    process.stdout.write(`${uninstallChromeHost(chrome(), realChromeHostDeps)}\n`);

    return 0;
  }

  if (flag(argv, 'uninstall') !== null) {
    await stopHub(home);
    uninstallActivity(makeRegistries().agents, home);
    uninstallChromeHost(chrome(), realChromeHostDeps);
    process.stdout.write('Removed the activity hooks and the browser registration, and stopped the hub.\n');

    return 0;
  }

  // Allow short idle intervals for tests and manual checks.
  const idle = Number(flag(argv, 'idle-ms'));
  const result = await serveHub({
    home,
    version: VERSION,
    // Reject nonpositive values and NaN, which would prevent idle shutdown and create a 1 ms timer.
    ...(idle > 0 ? { idleMs: idle } : {}),
  });

  if ('existing' in result) {
    process.stdout.write(`Hub already running for this home directory on port ${result.existing.record.port}.\n`);

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
