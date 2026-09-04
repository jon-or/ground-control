const assert = require('node:assert');
const vscode = require('vscode');

const settings = () => vscode.workspace.getConfiguration('groundControl');

async function api() {
  return vscode.extensions.getExtension('ownerrez.ground-control').activate();
}

/** Polls the snapshot rather than sleeping: a configure triggers a read, and a read is not instant. */
async function untilSnapshot(matches, why, within = 20_000) {
  const deadline = Date.now() + within;
  const read = await api();

  for (;;) {
    // Undefined until the hub has answered this window for the first time, which is a wait rather than a failure.
    const snapshot = read.snapshot();

    if (snapshot && matches(snapshot)) {
      return snapshot;
    }

    assert.ok(Date.now() < deadline, `${why}; last snapshot: ${JSON.stringify(snapshot?.failures ?? null)}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

describe('what this window pushes to the hub', () => {
  /** What the run was seeded with. Restoring to `undefined` would fall back to the developer's own CLIs (R30). */
  const OFFLINE_AGENTS = { claude: 'claude-not-on-this-path' };

  afterEach(async () => {
    await settings().update('agents', OFFLINE_AGENTS, vscode.ConfigurationTarget.Global);
  });

  /**
   * The settings this window reads have to arrive shaped the way the hub takes them. Every field of the `vscode`
   * host's own settings was once handed over as a host id, and the board said it could not reach into "userDir".
   */
  it('is taken whole, with nothing in it read as a target the board cannot reach', async () => {
    // A snapshot that proves this window's settings arrived, not merely the first one to turn up: the repo it
    // names is the one seeded into this run's profile, and no default would produce it.
    const { failures } = await untilSnapshot(
      (s) => s.issues !== null || s.failures.some((f) => f.subject === 'issues'),
      'no snapshot carrying this window\'s settings ever arrived',
    );

    assert.deepStrictEqual(
      failures.filter((failure) => failure.kind === 'unknown-host' || failure.kind === 'bad-config'),
      [],
      `settings were refused: ${failures.map((f) => f.message).join(' | ')}`,
    );
  });

  /**
   * R34's "without a reload": the configuration listener is the one path a change takes to the hub, and it has to
   * carry a setting being put back as well as a setting being made wrong. Only the second direction proves the
   * listener is still live after the first — a listener that fired once and died passes half of this.
   */
  it('reaches the hub when a setting changes, and again when it is changed back', async () => {
    const named = (s) => s.failures.some((f) => f.kind === 'bad-config' && f.message.includes('agents'));

    await settings().update('agents', { 'not-an-agent': 'nowhere/at/all' }, vscode.ConfigurationTarget.Global);
    await untilSnapshot(named, 'a CLI path the hub will not spawn was never named');

    await settings().update('agents', OFFLINE_AGENTS, vscode.ConfigurationTarget.Global);
    await untilSnapshot((s) => !named(s), 'the setting was put back and the board went on complaining about it');
  });

});
