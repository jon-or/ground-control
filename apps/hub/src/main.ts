import { homedir } from 'node:os';
import { makeRegistries, serveHub, stopHub, uninstallActivity } from '@ground-control/hub';
import { VERSION } from './version.js';

/**
 * The hub as its own process. Every decision below this line is in `@ground-control/hub`; this reads the arguments,
 * picks a mode, and reports what happened on the way out.
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

    process.stdout.write(stopped ? 'Stopped the hub.\n' : 'No hub is answering for this home.\n');

    return 0;
  }

  if (flag(argv, 'uninstall') !== null) {
    await stopHub(home);
    uninstallActivity(makeRegistries().agents, home);
    process.stdout.write('Removed the activity hooks and stopped the hub.\n');

    return 0;
  }

  // A short one is how a test drives the idle rule, and how a developer checks it without waiting half an hour.
  const idle = Number(flag(argv, 'idle-ms'));
  const result = await serveHub({
    home,
    version: VERSION,
    // Positive, not merely present: `NaN` reaches the idle rule as a comparison that is never true and a 1 ms timer.
    ...(idle > 0 ? { idleMs: idle } : {}),
  });

  if ('existing' in result) {
    process.stdout.write(`A hub is already serving this home on port ${result.existing.record.port}.\n`);

    return 0;
  }

  process.stdout.write(`Ground Control hub listening on 127.0.0.1:${result.served.port}.\n`);

  // Neither reaches a process without a console on Windows (mechanics §25); they are here for a foreground run.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void result.served.stop(`received ${signal}`).then(() => process.exit(0)));
  }

  crashesInto = result.served.log;

  return -1;
}

/** Set once the hub is serving, so a crash lands in `hub.log` beside the rest of its story rather than only on stderr. */
let crashesInto: (line: string) => void = () => {};

function report(what: string, error: unknown): void {
  crashesInto(`${what}: ${String(error)}`);
  process.stderr.write(`${what}: ${String(error)}\n`);
}

process.on('uncaughtException', (error) => {
  report('uncaughtException', error);
  process.exit(1);
});

// Reported and survived rather than fatal: a rejected write under a Windows file lock is not a reason to take a
// developer's tracking down, and an exit here skips `stop()`, so it would leave a stale reason behind as well.
process.on('unhandledRejection', (error) => report('unhandledRejection', error));

const code = await main(process.argv.slice(2));

// -1 means the server is holding the loop open; anything else is a mode that has finished.
if (code >= 0) {
  process.exit(code);
}
