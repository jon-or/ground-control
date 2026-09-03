import { homedir } from 'node:os';
import { makeRegistries, uninstallActivity } from '@ground-control/hub';

/**
 * Runs on `vscode:uninstall`, outside the extension host, so it imports nothing from `vscode` and shares nothing with a module that does.
 * Entries naming a writer nobody maintains would otherwise fire forever with nothing reading them — R34 applied to the extension's own removal.
 */
try {
  // Every decision is the hub's, including the refusal: nothing is taken away while an agent's settings still name
  // it, and the writer file is left behind on purpose. A session that goes on spawning a deleted script reports a
  // hook failure on every event for the rest of its life; two kilobytes is the cheaper cost.
  uninstallActivity(makeRegistries().agents, homedir());
} catch {
  // Uninstalling must not fail. What is left behind writes files nobody reads.
}
