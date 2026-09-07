const assert = require('node:assert');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const vscode = require('vscode');

const home = process.env.GC_TEST_HOME;
const hubLog = join(home, '.claude', 'ground-control', 'hub.log');

const api = () => vscode.extensions.getExtension('ownerrez.ground-control').activate();

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

describe('what this window can be shown about the hub (R40)', () => {
  before(async () => {
    await api();
  });

  /**
   * The whole path in one assertion: the command subscribes, the hub reads the tail of its own file, and the lines
   * come back down the stream this window is already riding. Until the command runs, none of that happens at all.
   */
  it('reads nothing until it is asked, and then carries what the hub has written', async () => {
    const extension = await api();

    assert.strictEqual(extension.logs().streaming, false, 'a window nobody asked was already streaming');
    assert.strictEqual(extension.logs().lines, 0, 'hub lines arrived before anything asked for them');

    await until(() => existsSync(hubLog) && readFileSync(hubLog, 'utf8').includes('listening on'), 'the hub never wrote a line');

    await vscode.commands.executeCommand('groundControl.toggleHubLog');

    assert.strictEqual(extension.logs().streaming, true, 'the command did not turn streaming on');

    const lines = await until(() => extension.logs().lines || false, 'nothing the hub wrote ever reached this window');

    // The way off, and the only one once the board that turned it on has been closed (R40).
    await vscode.commands.executeCommand('groundControl.toggleHubLog');

    assert.strictEqual(extension.logs().streaming, false, 'the toggle would not turn streaming off again');

    // What arrived stays: the channel keeps what it holds, and the count is of lines this window was sent.
    assert.ok(extension.logs().lines >= lines, 'turning it off discarded lines this window had already been sent');

    await vscode.commands.executeCommand('groundControl.toggleHubLog');

    assert.strictEqual(extension.logs().streaming, true, 'the toggle would not turn streaming back on');
  });

  /** Written whether or not anybody is looking, so there is nothing to subscribe to and nothing to turn off. */
  it('shows the board’s own log without subscribing to anything', async () => {
    const extension = await api();
    const before = extension.logs().streaming;

    await vscode.commands.executeCommand('groundControl.showBoardLog');

    assert.strictEqual(extension.logs().streaming, before, 'showing the board log changed what the hub is asked for');
  });
});
