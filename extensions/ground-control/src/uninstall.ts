import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { activityDirOf, claudeSettingsPathOf, planHookInstall } from '@ground-control/agent-claude';

/**
 * Runs on `vscode:uninstall`, outside the extension host, so it imports nothing from `vscode` and shares nothing with a module that does.
 * Entries naming a writer nobody maintains would otherwise fire forever with nothing reading them — R34 applied to the extension's own removal.
 */
const home = homedir();
const settings = claudeSettingsPathOf(home);

let text: string | null = null;

try {
  text = readFileSync(settings, 'utf8');
} catch {
  // No settings file, so nothing of ours is in one.
}

const plan = planHookInstall({ settingsText: text, home, wanted: 'remove' });

try {
  // Nothing is taken away while the settings still name it. A refusal leaves the entries in place, so the writer they point at stays too — a
  // session that goes on spawning a deleted script reports a hook failure on every event for the rest of its life.
  if (plan.kind === 'refuse') {
    process.exit(0);
  }

  if (plan.kind === 'write') {
    // In place, as the install writes it: a rename fails while a live session holds the file open.
    writeFileSync(settings, plan.text);
  }

  rmSync(activityDirOf(home), { recursive: true, force: true });
} catch {
  // Uninstalling must not fail. What is left behind writes files nobody reads.
}

// `hook.mjs` is deliberately left behind. Sessions that loaded the old settings go on spawning it until they end,
// and a deleted script makes each of them report a hook failure on every event; two kilobytes is the cheaper cost.
