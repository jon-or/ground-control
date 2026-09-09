const assert = require('node:assert');
const vscode = require('vscode');

/**
 * Verify activation registers the URI handler and accepted links reach the hub. Package tests cover URI
 * validation.
 */
describe('browser session URI handling', () => {
  const SESSION = 'a1b2c3d4-0000-4000-8000-000000000000';

  /** Every notification this window raised while a link was in flight. */
  let warned = [];
  let original;

  before(async () => {
    await vscode.extensions.getExtension('groundcontrol.ground-control').activate();

    original = vscode.window.showWarningMessage;
    vscode.window.showWarningMessage = (message) => {
      warned.push(message);

      return Promise.resolve(undefined);
    };
  });

  after(() => {
    if (original) {
      vscode.window.showWarningMessage = original;
    }
  });

  beforeEach(() => {
    warned = [];
  });

  /** Polls: the handler is async, the hub answers over a socket, and `vscode.open` waits for neither. */
  async function waitForWarning(matches, why, within = 15_000) {
    const deadline = Date.now() + within;

    for (;;) {
      const found = warned.find((message) => matches(message));

      if (found) {
        return found;
      }

      assert.ok(Date.now() < deadline, `${why}; warnings: ${JSON.stringify(warned)}`);
      await new Promise((done) => setTimeout(done, 100));
    }
  }

  const fire = (uri) => vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(uri));

  /**
   * Assert the hub missing-session refusal; silence would not prove handler execution.
   */
  it('carries a well-formed session id through to the hub, which answers for it', async () => {
    await fire(`vscode://groundcontrol.ground-control/open?session=${SESSION}`);

    await waitForWarning(
      (message) => message.includes('no longer on the board'),
      'the link did not reach the hub',
    );
  });

  /**
   * Assert the missing-run response for attach URIs; absence of a terminal alone would not prove the handler
   * ran.
   */
  it('answers an attach link for a run this machine does not have', async () => {
    const before = vscode.window.terminals.length;

    await fire(`vscode://groundcontrol.ground-control/attach?session=${SESSION}`);

    await waitForWarning(
      (message) => message.includes('This run is unavailable or does not support attaching.'),
      'the attach link did not reach the handler',
      30_000,
    );

    assert.strictEqual(vscode.window.terminals.length, before, 'a terminal was opened for a run that is not there');
  });

  /** Any page in the browser can navigate here, so everything but one well-formed id is refused out loud. */
  for (const [why, uri] of [
    ['a path the board never writes', `vscode://groundcontrol.ground-control/seize?session=${SESSION}`],
    ['no session at all', 'vscode://groundcontrol.ground-control/open'],
    ['something that is not an id', 'vscode://groundcontrol.ground-control/open?session=../../etc/passwd'],
    ['an attach with no session at all', 'vscode://groundcontrol.ground-control/attach'],
    ['an attach naming something that is not an id', 'vscode://groundcontrol.ground-control/attach?session=%2E%2E%2Fetc'],
  ]) {
    it(`refuses ${why}, and says so`, async () => {
      await fire(uri);

      const message = await waitForWarning(
        (said_) => said_.includes('Invalid or unsupported session link.'),
        `no warning for ${uri}`,
      );

      // Refused here rather than passed on: the hub never hears about a link this window would not write.
      assert.ok(!message.includes('no longer on the board'));
    });
  }
});
