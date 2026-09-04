import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  bundlePathOf,
  chromeHostPlan,
  makeRegistries,
  realChromeHostDeps,
  stopHub,
  uninstallActivity,
  uninstallChromeHost,
} from '@ground-control/hub';

/**
 * Runs on `vscode:uninstall`, outside the extension host, so it imports nothing from `vscode` and shares nothing with a module that does.
 * Entries naming a writer nobody maintains would otherwise fire forever with nothing reading them — R34 applied to the extension's own removal.
 */
void (async () => {
  const home = homedir();

  try {
    // First, or the hub reinstalls what the next step takes away. It is the only thing still running at this point.
    await stopHub(home);
  } catch {
    // Nothing answering is the common case, and a hub that will not stop is not a reason to leave hooks behind.
  }

  try {
    // Every decision is the hub's, including the refusal: nothing is taken away while an agent's settings still name
    // it, and the writer file is left behind on purpose. A session that goes on spawning a deleted script reports a
    // hook failure on every event for the rest of its life; two kilobytes is the cheaper cost.
    uninstallActivity(makeRegistries().agents, home);

    // The browser registration goes too. What it names is the bundle removed on the next line, so left behind it
    // has Chrome starting a host that is not there and saying nothing about why (R34).
    uninstallChromeHost(
      chromeHostPlan({ platform: process.platform, home, bundle: bundlePathOf(home), node: process.execPath }),
      realChromeHostDeps,
    );
    rmSync(bundlePathOf(home), { force: true });
  } catch {
    // Uninstalling must not fail. What is left behind writes files nobody reads.
  }
})();
