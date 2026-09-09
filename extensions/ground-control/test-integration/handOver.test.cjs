const assert = require('node:assert');
const vscode = require('vscode');

/**
 * Verify that session and handover URIs reach the hub through registerUriHandler (mechanics M29). URI
 * parameters cannot authorize a reveal: the hub must validate identity and surface to avoid a second process
 * on a sidebar session (M6).
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
      answer.includes('Invalid or unsupported session link.'),
      `expected the handler own refusal for a malformed id, got: ${answer}`,
    );
  });
});
