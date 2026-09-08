const assert = require('node:assert');
const vscode = require('vscode');

/**
 * The board's URI reaches this window's handler and goes to the hub — a hand-over included. §29 measured that
 * `vscode.open` on a `vscode://groundcontrol.ground-control/…` URI routes to `registerUriHandler` in a real host,
 * which is what makes this measurable without a browser.
 *
 * Each case proves the hub answered. This link is reachable from any page, so a hand-over revealed on the link's
 * own word would let a page open a panel bound to an id of its choosing — and on a session Claude holds in its
 * sidebar, that is the second-process-on-one-transcript defect §6 measured.
 */
describe('a session handed to this window', () => {
  const SESSION = '01a072f9-c43a-73e2-a4fd-3a63e73ad152';

  /** The hub's own answer for an id it has never seen, which is what proves the request reached it. */
  const REFUSED = 'no longer on the board';

  let noticed = [];
  let warned;
  let informed;

  before(async () => {
    await vscode.extensions.getExtension('groundcontrol.ground-control').activate();

    warned = vscode.window.showWarningMessage;
    informed = vscode.window.showInformationMessage;
    vscode.window.showWarningMessage = (message) => {
      noticed.push(message);

      return Promise.resolve(undefined);
    };
    vscode.window.showInformationMessage = (message) => {
      noticed.push(message);

      return Promise.resolve(undefined);
    };
  });

  after(() => {
    if (warned) {
      vscode.window.showWarningMessage = warned;
    }

    if (informed) {
      vscode.window.showInformationMessage = informed;
    }
  });

  beforeEach(() => {
    noticed = [];
  });

  const fire = async (query) => {
    await vscode.commands.executeCommand(
      'vscode.open',
      vscode.Uri.parse(`vscode://groundcontrol.ground-control/open?${query}`),
    );

    for (let waited = 0; waited < 10_000 && noticed.length === 0; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return noticed.join(' | ');
  };

  it('is planned by the hub rather than revealed on the link own word', async () => {
    const answer = await fire(`session=${SESSION}&agent=codex&hop=1`);

    assert.ok(answer.includes(REFUSED), `expected the hub to refuse an unknown session, got: ${answer}`);
  });

  it('is planned the same way as a link a developer clicked', async () => {
    const answer = await fire(`session=${SESSION}`);

    assert.ok(answer.includes(REFUSED), `expected the hub to refuse an unknown session, got: ${answer}`);
  });

  it('is planned even when the hand-over names no agent, which names nothing to reveal it with', async () => {
    const answer = await fire(`session=${SESSION}&hop=1`);

    assert.ok(answer.includes(REFUSED), `expected the hub to refuse an unknown session, got: ${answer}`);
  });

  it('refuses a link that does not name a session at all, without the hub hearing of it', async () => {
    const answer = await fire('session=../../etc/passwd&hop=1&agent=claude');

    assert.ok(
      answer.includes('does not name a session'),
      `expected the handler own refusal for a malformed id, got: ${answer}`,
    );
  });
});
