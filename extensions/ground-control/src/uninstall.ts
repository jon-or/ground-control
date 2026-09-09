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

/** Run outside the extension host without vscode imports. Remove activity hook entries during uninstall (R34). */
void (async () => {
  const home = homedir();

  try {
    // Stop the hub before removing hooks so it cannot reinstall them.
    await stopHub(home);
  } catch {
    // Nothing answering is the common case, and a hub that will not stop is not a reason to leave hooks behind.
  }

  try {
    // Retain the writer after removing settings entries; active sessions may still use cached hooks.
    uninstallActivity(makeRegistries().agents, home);

    // Remove the native-host registration before its bundle so Chrome cannot start a missing executable
    // (R34).
    uninstallChromeHost(
      chromeHostPlan({ platform: process.platform, home, bundle: bundlePathOf(home), node: process.execPath }),
      realChromeHostDeps,
    );
    rmSync(bundlePathOf(home), { force: true });
  } catch {
    // Uninstalling must not fail. What is left behind writes files nobody reads.
  }
})();
