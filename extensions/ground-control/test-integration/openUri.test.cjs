const assert = require('node:assert');
const vscode = require('vscode');

/**
 * The URI handler is registered on activation and answers a navigation from the browser board. What only a real
 * extension host settles is that the registration takes, that a link reaches it, and that what it accepts goes on
 * to the hub — the decision about what a link may name is `sessionFromUri`, tested in `packages/host-vscode`.
 */
describe('the link the browser board opens a session with', () => {
  const SESSION = 'a1b2c3d4-0000-4000-8000-000000000000';

  /** Every notification this window raised while a link was in flight. */
  let warned = [];
  let original;

  before(async () => {
    await vscode.extensions.getExtension('ownerrez.ground-control').activate();

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
  async function said(matches, why, within = 15_000) {
    const deadline = Date.now() + within;

    for (;;) {
      const found = warned.find((message) => matches(message));

      if (found) {
        return found;
      }

      assert.ok(Date.now() < deadline, `${why}; said: ${JSON.stringify(warned)}`);
      await new Promise((done) => setTimeout(done, 100));
    }
  }

  const fire = (uri) => vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(uri));

  /**
   * The whole chain, proven by the answer that comes back: this window's hub is running against a temporary home
   * with no agent CLI on it, so a well-formed link is carried through to a hub that refuses the id by name. An
   * assertion that merely nothing was said would pass on a handler that never ran.
   */
  it('carries a well-formed session id through to the hub, which answers for it', async () => {
    await fire(`vscode://ownerrez.ground-control/open?session=${SESSION}`);

    await said(
      (message) => message.includes('no longer on the board'),
      'the link did not reach the hub',
    );
  });

  /** Any page in the browser can navigate here, so everything but one well-formed id is refused out loud. */
  for (const [why, uri] of [
    ['a path the board never writes', `vscode://ownerrez.ground-control/seize?session=${SESSION}`],
    ['no session at all', 'vscode://ownerrez.ground-control/open'],
    ['something that is not an id', 'vscode://ownerrez.ground-control/open?session=../../etc/passwd'],
  ]) {
    it(`refuses ${why}, and says so`, async () => {
      await fire(uri);

      const message = await said(
        (said_) => said_.includes('does not name a session'),
        `nothing was said about ${uri}`,
      );

      // Refused here rather than passed on: the hub never hears about a link this window would not write.
      assert.ok(!message.includes('no longer on the board'));
    });
  }
});
