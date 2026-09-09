const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vscode = require('vscode');

const settings = () => vscode.workspace.getConfiguration('groundControl');

const configJson = join(process.env.GC_TEST_HOME, '.claude', 'ground-control', 'config.json');

/** Never throws: a hub mid-write and a hub that has stored nothing yet are both "not this configuration yet". */
function stored() {
  try {
    return JSON.parse(readFileSync(configJson, 'utf8'));
  } catch {
    return null;
  }
}

async function untilStored(matches, why, within = 20_000) {
  const deadline = Date.now() + within;

  for (;;) {
    const config = stored();

    if (config && matches(config)) {
      return config;
    }

    assert.ok(Date.now() < deadline, `${why}; last stored: ${JSON.stringify(stored()?.actions ?? null)}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

async function api() {
  return vscode.extensions.getExtension('groundcontrol.ground-control').activate();
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
    await settings().update('hosts', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('sources', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('actions.merge-upstream.enabled', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('actions.merge-upstream.prompt', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('triage.mode', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('triage.enabled', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('triage.dailyLimit', undefined, vscode.ConfigurationTarget.Global);
  });

  /** Verify the host configuration structure reaches the hub without treating setting fields as host IDs. */
  it('is taken whole, with nothing in it read as a target the board cannot reach', async () => {
    // Wait for evidence that the window configuration reached the hub, not merely its first snapshot.
    const { failures } = await untilSnapshot(
      (s) => s.failures.some((f) => f.subject === 'github' && f.kind !== 'bad-config'),
      'no snapshot carrying this window\'s settings ever arrived',
    );

    assert.deepStrictEqual(
      failures.filter((f) => f.kind === 'unknown-host' || f.kind === 'unknown-source' || f.kind === 'bad-config'),
      [],
      `settings were refused: ${failures.map((f) => f.message).join(' | ')}`,
    );
  });

  it('defaults triage to manual and preserves explicit legacy choices until a mode is selected', async () => {
    await untilStored((c) => c.triage?.mode === 'manual', 'fresh triage did not default to manual');
    await settings().update('triage.enabled', true, vscode.ConfigurationTarget.Global);
    await untilStored((c) => c.triage?.mode === 'automatic', 'explicit legacy true did not select automatic');
    await settings().update('triage.enabled', false, vscode.ConfigurationTarget.Global);
    await untilStored((c) => c.triage?.mode === 'off', 'explicit legacy false did not select off');
    await settings().update('triage.mode', 'manual', vscode.ConfigurationTarget.Global);
    await settings().update('triage.dailyLimit', 3, vscode.ConfigurationTarget.Global);
    await untilStored((c) => c.triage?.mode === 'manual' && c.triage.dailyLimit === 3 && c.triage.enabled,
      'explicit mode and limit did not reach the hub');
    await untilSnapshot((s) => s.triage?.mode === 'manual' && s.triage.canRequest, 'manual capability was not displayed');
  });

  /** Unknown host and source IDs must produce named failures in hub state. */
  it('carries an editor id the board does not know through to the lanes', async () => {
    await settings().update('hosts', ['not-an-editor'], vscode.ConfigurationTarget.Global);

    const { failures } = await untilSnapshot(
      (s) => s.failures.some((f) => f.kind === 'unknown-host'),
      'a host id nothing carries was never named',
    );

    assert.strictEqual(failures.find((f) => f.kind === 'unknown-host').subject, 'not-an-editor');
  });

  it('carries a work source the board does not know through to the lanes', async () => {
    await settings().update('sources', ['jira'], vscode.ConfigurationTarget.Global);

    const { failures } = await untilSnapshot(
      (s) => s.failures.some((f) => f.kind === 'unknown-source'),
      'a source id nothing carries was never named',
    );

    assert.strictEqual(failures.find((f) => f.kind === 'unknown-source').subject, 'jira');
  });

  /** A hand-edited settings.json holds whatever was typed. Read as a list, a bare string is a crash out of activation. */
  it('falls back to the shipped ids when the setting is not a list at all', async () => {
    await settings().update('hosts', 'vscode', vscode.ConfigurationTarget.Global);

    await untilSnapshot(
      (s) => !s.failures.some((f) => f.kind === 'unknown-host'),
      'a setting that is not a list took the board with it',
    );
  });

  /**
   * Verify configuration changes and restoration without reload; both directions establish that the listener
   * remains active (R34).
   */
  it('reaches the hub when a setting changes, and again when it is changed back', async () => {
    const named = (s) => s.failures.some((f) => f.kind === 'bad-config' && f.message.includes('agents'));

    await settings().update('agents', { 'not-an-agent': 'nowhere/at/all' }, vscode.ConfigurationTarget.Global);
    await untilSnapshot(named, 'a CLI path the hub will not spawn was never named');

    await settings().update('agents', OFFLINE_AGENTS, vscode.ConfigurationTarget.Global);
    await untilSnapshot((s) => !named(s), 'the setting was put back and the board went on complaining about it');
  });

  /**
   * Update the declared flat action keys through VS Code; undeclared or nested replacements must fail (R34,
   * mechanics M50).
   */
  it('carries the merge-upstream action from the two keys the settings editor writes', async () => {
    const prompt = '/or-merge {base} {branch} {issue} --single';

    await settings().update('actions.merge-upstream.enabled', true, vscode.ConfigurationTarget.Global);
    await settings().update('actions.merge-upstream.prompt', prompt, vscode.ConfigurationTarget.Global);

    const config = await untilStored(
      (c) => c.actions?.actions?.['merge-upstream'] !== undefined,
      'the action never reached the hub',
    );

    assert.deepStrictEqual(config.actions.actions['merge-upstream'], { enabled: true, prompt });

    await settings().update('actions.merge-upstream.prompt', undefined, vscode.ConfigurationTarget.Global);

    await untilStored(
      (c) => c.actions?.actions?.['merge-upstream'] === undefined,
      'the prompt was cleared and the action went on being carried',
    );
  });
});

/** Verify session-start settings and per-client capabilities across the real VS Code boundary (R42). */
describe('what this window is told about starting a session on a card', () => {
  afterEach(async () => {
    await settings().update('newSession.prompt', undefined, vscode.ConfigurationTarget.Global);
  });

  /**
   * Read persisted hub configuration because the start prompt is absent from snapshots and this fixture has no
   * cards.
   */
  it('carries the new-session prompt to the hub with its placeholders intact', async () => {
    const PROMPT = 'Work on #{issue} in {checkout}.';

    await settings().update('newSession.prompt', PROMPT, vscode.ConfigurationTarget.Global);

    await untilStored((config) => config.newSession?.prompt === PROMPT, 'the hub never stored the prompt');
  });

  /**
   * Verify the window announces start-session and receives capabilities from the real host adapter. Package
   * tests cover agent ordering.
   */
  it('is offered a start for the agent it places, rather than the empty list a browser gets', async () => {
    const { startable } = await untilSnapshot(
      (s) => s.startable.length > 0,
      'no snapshot ever named an agent this window can start',
    );

    assert.ok(
      startable.some((offered) => offered.agent === 'claude'),
      `expected Claude among the startable agents, got ${JSON.stringify(startable)}`,
    );
  });
});
