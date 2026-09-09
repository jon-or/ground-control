const assert = require('node:assert');
const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const vscode = require('vscode');

const home = process.env.GC_TEST_HOME;
const activityDir = join(home, '.claude', 'ground-control', 'activity');
const agentSettings = join(home, '.claude', 'settings.json');

/** How many of the agent's own hook entries name this board's writer. Zero is the signal removed. */
function installedHooks(path = agentSettings) {
  try {
    return (readFileSync(path, 'utf8').match(/ground-control/g) ?? []).length;
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
    await vscode.extensions.getExtension('groundcontrol.ground-control').activate();
  });

  afterEach(async () => {
    await settings().update('sessionHooks.claude', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('sessionHooks.codex', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('installSessionHooks', true, vscode.ConfigurationTarget.Global);
  });

  it('activates and registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);

    assert.deepStrictEqual(
      commands.filter((name) => name.startsWith('groundControl.')).sort(),
      [
        'groundControl.disableGithubOverlay',
        'groundControl.enableGithubOverlay',
        'groundControl.openBoard',
        'groundControl.openChanges',
        'groundControl.refresh',
        'groundControl.removeSessionHooks',
        'groundControl.showBoardLog',
        'groundControl.toggleHubLog',
      ],
    );
  });

  it('opens the board as a tab', async () => {
    await vscode.commands.executeCommand('groundControl.openBoard');

    await until(
      () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => tab.label === 'Ground Control'),
      'no tab called Ground Control ever appeared',
    );
  });

  it('propagates per-agent hook settings and removes omitted agents while preserving the other hooks', async () => {
    const originalAgents = settings().get('agents');
    const codexHooks = join(home, '.codex', 'hooks.json');
    mkdirSync(join(home, '.codex'), { recursive: true });
    assert.strictEqual(process.env.CODEX_HOME, join(home, '.codex'), 'Codex must use the isolated test home');

    try {
      await settings().update('agents', { claude: 'claude-not-on-this-path', codex: 'codex-not-on-this-path' }, vscode.ConfigurationTarget.Global);
      await until(() => installedHooks() > 0 && installedHooks(codexHooks) > 0, 'both adapters were not installed');
      await settings().update('sessionHooks.claude', false, vscode.ConfigurationTarget.Global);
      await until(() => installedHooks() === 0 && installedHooks(codexHooks) > 0, 'Claude hook choice did not reach the hub');
      await settings().update('sessionHooks.claude', true, vscode.ConfigurationTarget.Global);
      await settings().update('sessionHooks.codex', false, vscode.ConfigurationTarget.Global);
      await until(() => installedHooks() > 0 && installedHooks(codexHooks) === 0, 'Codex hook choice did not reach the hub');
      await settings().update('sessionHooks.codex', true, vscode.ConfigurationTarget.Global);
      await until(() => installedHooks(codexHooks) > 0, 'Codex hooks did not return');
      await settings().update('agents', { claude: 'claude-not-on-this-path' }, vscode.ConfigurationTarget.Global);
      await until(() => installedHooks() > 0 && installedHooks(codexHooks) === 0, 'omitted Codex hooks were not removed');
      await settings().update('installSessionHooks', false, vscode.ConfigurationTarget.Global);
      await until(() => installedHooks() === 0 && installedHooks(codexHooks) === 0, 'global removal did not override selected hooks');
    } finally {
      await settings().update('agents', originalAgents, vscode.ConfigurationTarget.Global);
    }
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

    // The directory itself stays: one that anything holds open after a delete cannot be created back (mechanics M23).
    assert.ok(existsSync(activityDir), 'the directory survived the removal');

    await settings().update('installSessionHooks', true, vscode.ConfigurationTarget.Global);
    await until(() => installedHooks() > 0, 'the hook entries did not come back');
  });
});
