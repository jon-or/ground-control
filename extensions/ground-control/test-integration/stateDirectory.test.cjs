const assert = require('node:assert');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const vscode = require('vscode');

const home = process.env.GC_TEST_HOME;
const bootstrap = join(home, '.claude', 'ground-control');
const pointer = join(bootstrap, 'state-dir.json');
const elsewhere = join(home, 'relocated-state');

const settings = () => vscode.workspace.getConfiguration('groundControl');
const api = () => vscode.extensions.getExtension('groundcontrol.ground-control').activate();

/** Never throws: a hub mid-write, a stopped hub, and no hub at all are all "nothing to reach yet". */
function record(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'hub.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function until(what, why, within = 30_000) {
  const deadline = Date.now() + within;

  for (;;) {
    const answer = await what();

    if (answer) {
      return answer;
    }

    assert.ok(Date.now() < deadline, why);
    await new Promise((done) => setTimeout(done, 200));
  }
}

describe('moving the state directory from the setting (R34, R35)', () => {
  before(async () => {
    await api();
    await until(() => record(bootstrap), 'no hub was ever started in the default directory');
  });

  /** Set the setting, then observe hub.json under the new directory: the move, the pointer, and the restart happened. */
  it('moves the state, records the pointer, and reconnects to a hub serving the new directory', async () => {
    const before = await until(() => record(bootstrap), 'no hub.json in the default directory');
    const extension = await api();
    const shown = await until(() => extension.snapshot(), 'this window never received a snapshot before the move');

    await settings().update('stateDirectory', elsewhere, vscode.ConfigurationTarget.Global);

    const after = await until(() => {
      const held = record(elsewhere);

      return held && held.pid !== before.pid ? held : null;
    }, 'no hub started for the relocated directory');

    assert.ok(existsSync(join(elsewhere, 'hub.log')), 'hub.log did not move with the state');
    assert.deepStrictEqual(JSON.parse(readFileSync(pointer, 'utf8')), { stateDir: elsewhere.replace(/\\/g, '/') });
    assert.notStrictEqual(after.fingerprint, before.fingerprint, 'the relocated hub still identifies the old directory');

    const left = readdirSync(bootstrap).filter((name) => !/^(state-dir\.json|hub\.js|hook\.mjs|codex-hook\.mjs|hub-exit\.json|relocate\.lock|.*\.tmp)$/.test(name));

    assert.deepStrictEqual(left, [], `state files remained in the default directory: ${left.join(', ')}`);

    await until(() => extension.snapshot() !== shown, 'this window never received a snapshot from the relocated hub');
  });

  it('moves back when the setting is cleared, and removes the pointer', async () => {
    const before = await until(() => record(elsewhere), 'no hub.json in the relocated directory');

    await settings().update('stateDirectory', undefined, vscode.ConfigurationTarget.Global);

    await until(() => {
      const held = record(bootstrap);

      return held && held.pid !== before.pid ? held : null;
    }, 'no hub started again for the default directory');

    assert.strictEqual(existsSync(pointer), false, 'the pointer survived a move back to the default directory');
    assert.ok(existsSync(join(bootstrap, 'hub.log')), 'hub.log did not move back');
    assert.strictEqual(existsSync(join(elsewhere, 'hub.json')), false, 'the old hub record remained in the relocated directory');
  });

  it('refuses a relative directory and restores the setting', async () => {
    await settings().update('stateDirectory', 'relative/state', vscode.ConfigurationTarget.Global);

    await until(() => settings().inspect('stateDirectory')?.globalValue === undefined, 'the refused setting was not restored');

    assert.strictEqual(existsSync(pointer), false, 'a refused setting wrote a pointer');
  });
});
