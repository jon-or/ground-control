const assert = require('node:assert');
const { existsSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const vscode = require('vscode');

const home = process.env.GC_TEST_HOME;
const activityDir = join(home, '.claude', 'ground-control', 'activity');
const agentSettings = join(home, '.claude', 'settings.json');

/** How many of the agent's own hook entries name this board's writer. Zero is the signal removed. */
function installedHooks() {
  try {
    return (readFileSync(agentSettings, 'utf8').match(/ground-control/g) ?? []).length;
  } catch {
    return 0;
  }
}

const settings = () => vscode.workspace.getConfiguration('groundControl');

/** Waits for a thing to become true rather than for a duration: the install takes a lock and retries under it. */
async function until(what, why, within = 20_000) {
  const deadline = Date.now() + within;

  for (;;) {
    if (what()) {
      return;
    }

    assert.ok(Date.now() < deadline, why);
    await new Promise((done) => setTimeout(done, 100));
  }
}

describe('the extension in a real window', () => {
  before(async () => {
    // Activated on purpose: nothing is registered until a board is opened, which is what R35 is about.
    await vscode.extensions.getExtension('ownerrez.ground-control').activate();
  });

  afterEach(async () => {
    await settings().update('installSessionHooks', true, vscode.ConfigurationTarget.Global);
  });

  it('activates and registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);

    assert.deepStrictEqual(
      commands.filter((name) => name.startsWith('groundControl.')).sort(),
      ['groundControl.openBoard', 'groundControl.refresh', 'groundControl.removeSessionHooks'],
    );
  });

  it('opens the board as a tab', async () => {
    await vscode.commands.executeCommand('groundControl.openBoard');

    await until(
      () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => tab.label === 'Ground Control'),
      'no tab called Ground Control ever appeared',
    );
  });

  /**
   * R34: turning the signal off has to take the markers away, and turning it back on has to put the directory back.
   * The marker is written by hand because a temp home has no live session to write one — without it, "the directory
   * is empty" is true of a removal that did nothing at all.
   */
  it('empties the activity markers when the signal is turned off, and installs again when it is turned back on', async () => {
    await until(() => installedHooks() > 0, 'the hook entries were never written');
    writeFileSync(join(activityDir, 'a1b2c3d4-0000-4000-8000-000000000000.json'), '{"phase":"working"}');

    await settings().update('installSessionHooks', false, vscode.ConfigurationTarget.Global);
    await until(() => installedHooks() === 0, 'the hook entries were still in the agent settings');
    await until(() => readdirSync(activityDir).length === 0, 'the markers were still there after turning it off');

    // The directory itself stays: one that anything holds open after a delete cannot be created back (mechanics §23).
    assert.ok(existsSync(activityDir), 'the directory survived the removal');

    await settings().update('installSessionHooks', true, vscode.ConfigurationTarget.Global);
    await until(() => installedHooks() > 0, 'the hook entries did not come back');
  });
});
