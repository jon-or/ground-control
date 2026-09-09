const assert = require('node:assert/strict');
const { join } = require('node:path');
const vscode = require('vscode');

describe('test installation isolation', () => {
  it('uses portable mode with the seeded test profile', () => {
    assert.equal(process.env.VSCODE_PORTABLE, process.env.GC_TEST_PORTABLE);
    assert.ok(process.env.VSCODE_PORTABLE, 'the test build disabled portable mode');
    assert.equal(process.env.GC_TEST_PROFILE, join(process.env.VSCODE_PORTABLE, 'user-data'));
    assert.equal(vscode.workspace.getConfiguration('groundControl.github').get('ghPath'), 'gh-not-on-this-path');
  });

  it('preserves the Windows vscode:// handler after startup', async function () {
    if (process.platform !== 'win32') this.skip();

    const { protocolRegistration } = await import('./protocol.mjs');
    assert.deepEqual(protocolRegistration(), JSON.parse(process.env.GC_TEST_PROTOCOL));
  });
});
