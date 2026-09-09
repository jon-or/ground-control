const assert = require('node:assert');
const vscode = require('vscode');

describe('the board in a real webview', () => {
  /**
   * Verify that the real webview script starts and reports its rendered state. Missing bundles or CSP failures
   * otherwise leave the loading screen unchanged (R25). Card rendering belongs in jsdom tests with populated
   * snapshots; this isolated host has no agent or GitHub data.
   */
  it('loads its script, and reports the screen it finished rather than the one it started', async () => {
    const api = await vscode.extensions.getExtension('groundcontrol.ground-control').activate();

    await vscode.commands.executeCommand('groundControl.openBoard');

    const deadline = Date.now() + 20_000;

    for (;;) {
      const drew = api.drew();

      if (drew) {
        // `Reading GitHub…` is what the panel puts there before the script has run; a card count is what the script
        // writes once it has. Reporting mid-render named the first of those.
        assert.match(drew.meta, /\d+ cards?/, `the meta line is the one the panel wrote, not this render's: ${drew.meta}`);

        return;
      }

      assert.ok(Date.now() < deadline, 'the board never reported drawing anything');
      await new Promise((done) => setTimeout(done, 100));
    }
  });
});
