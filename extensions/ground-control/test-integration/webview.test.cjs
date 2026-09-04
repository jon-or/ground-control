const assert = require('node:assert');
const vscode = require('vscode');

describe('the board in a real webview', () => {
  /**
   * The one thing no other layer can see: that the script runs at all. A content policy that rejects it, or a bundle
   * that is not there, leaves the board on its loading line forever while every other test in the tree still passes,
   * and the developer is told nothing (R25).
   *
   * What it draws is not asserted here. This window is pointed at CLIs that do not exist, so the board has no cards
   * to lay out, and an assertion over an empty board holds for a board that drew nothing at all. Rendering is jsdom's,
   * where the payload is given rather than read.
   */
  it('loads its script, and reports the screen it finished rather than the one it started', async () => {
    const api = await vscode.extensions.getExtension('ownerrez.ground-control').activate();

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
