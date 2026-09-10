const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vscode = require('vscode');

const settings = () => vscode.workspace.getConfiguration('groundControl');
const SESSION_SCOPE_KEYS = ['includeRepositories', 'excludeRepositories', 'includeDirectories', 'excludeDirectories', 'showHistory', 'showAdHoc'];

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
    await settings().update('triage.model', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('actions.agent', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('actions.model', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('actions.permissionMode', undefined, vscode.ConfigurationTarget.Global);
    for (const key of SESSION_SCOPE_KEYS) {
      await settings().update(`sessions.${key}`, undefined, vscode.ConfigurationTarget.Global);
    }
    await settings().update('github.projectOwner', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('github.statusField', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('github.maxPages', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('avatar.review', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('avatar.offReview', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('idleExitMinutes', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('logLevel', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('logs.rotateMegabytes', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('logs.keep', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('logs.dispatchRetentionDays', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('resumeWorktreesInRepositoryWindow', undefined, vscode.ConfigurationTarget.Global);
  });

  it('sends the log floor and retention settings in the units the hub keeps', async () => {
    await settings().update('logLevel', 'warn', vscode.ConfigurationTarget.Global);
    await settings().update('logs.rotateMegabytes', 5, vscode.ConfigurationTarget.Global);
    await settings().update('logs.keep', 0, vscode.ConfigurationTarget.Global);
    await settings().update('logs.dispatchRetentionDays', 1, vscode.ConfigurationTarget.Global);
    await untilStored(
      (c) => c.logLevel === 'warn' && c.logs?.rotateBytes === 5_000_000 && c.logs?.kept === 0 && c.logs?.dispatchRetentionMs === 24 * 60 * 60 * 1000,
      'the log settings never reached the hub',
    );
  });

  it('sends the page limit to the hub unclamped, leaving values outside the bound to its refusal', async () => {
    await untilStored((c) => c.sources?.github?.maxPages === 5, 'the default page limit never reached the hub');
    await settings().update('github.maxPages', 7, vscode.ConfigurationTarget.Global);
    await untilStored((c) => c.sources?.github?.maxPages === 7, 'a page limit of seven never reached the hub');
    // A refused configuration is not stored, so the refusal itself is the evidence that nothing clamped the value first.
    await settings().update('github.maxPages', 25, vscode.ConfigurationTarget.Global);
    await untilSnapshot((s) => s.failures.some((f) => f.subject === 'github' && f.kind === 'bad-config' && f.message.includes('maxPages')), 'the hub did not refuse 25 pages');
  });

  /** The test host is a stable build, so its own scheme is `vscode`; an Insiders host would report vscode-insiders. */
  it('reports the running editor\'s URI scheme to the hub for browser links', async () => {
    await untilStored((c) => c.hosts?.vscode?.uriScheme === vscode.env.uriScheme, 'the editor scheme never reached the hub');
    const { editor } = await untilSnapshot((s) => s.editor !== undefined, 'no snapshot carried the editor scheme');
    assert.strictEqual(editor.uriScheme, vscode.env.uriScheme);
  });

  /** The test profile seeds an explicit agents setting, which is the migrated case: hooks install without a prompt. */
  it('treats an explicit agents setting as a completed setup and installs hooks without asking', async () => {
    await untilStored((c) => c.installActivity === true, 'a migrated install withheld hook installation');
    assert.ok((await vscode.commands.getCommands(true)).includes('groundControl.runSetup'));
  });

  it('sends both sides of the avatar policy to the hub', async () => {
    await untilStored((c) => c.avatar?.review === 'pull-request-author' && c.avatar?.offReview === 'assignee',
      'the default avatar policy never reached the hub');
    await settings().update('avatar.offReview', 'issue-author', vscode.ConfigurationTarget.Global);
    await untilStored((c) => c.avatar?.offReview === 'issue-author' && c.avatar?.review === 'pull-request-author',
      'the issue-author side never reached the hub, or it moved the review side with it');
  });

  it('sends the idle exit window in milliseconds and lets the hub clamp it', async () => {
    await untilStored((c) => c.idleExitMs === 30 * 60 * 1000, 'the default idle window never reached the hub');
    await settings().update('idleExitMinutes', 2, vscode.ConfigurationTarget.Global);
    await untilStored((c) => c.idleExitMs === 120_000, 'a two-minute window never reached the hub');
    await settings().update('idleExitMinutes', 0, vscode.ConfigurationTarget.Global);
    await untilStored((c) => c.idleExitMs === 60_000, 'a zero window was not lifted to the floor');
  });

  it('sends the project owner and status field to the hub', async () => {
    await untilStored((c) => c.sources?.github?.statusField === 'Status' && c.sources?.github?.projectOwner === '', 'the defaults never reached the hub');
    await settings().update('github.projectOwner', 'their-org', vscode.ConfigurationTarget.Global);
    await settings().update('github.statusField', 'Stage', vscode.ConfigurationTarget.Global);
    await untilStored((c) => c.sources?.github?.projectOwner === 'their-org' && c.sources?.github?.statusField === 'Stage', 'the project settings never reached the hub');
  });

  /** The routing setting is read by the host adapter, so it must survive the hub's own configuration parse (R43). */
  it('carries the repository-window resume setting to the editor host settings', async () => {
    await untilStored((c) => c.hosts?.vscode?.resumeWorktreesInRepositoryWindow === false, 'the setting did not reach the hub as off');
    await settings().update('resumeWorktreesInRepositoryWindow', true, vscode.ConfigurationTarget.Global);
    await untilStored((c) => c.hosts?.vscode?.resumeWorktreesInRepositoryWindow === true, 'turning the setting on did not reach the hub');
    await untilSnapshot((s) => !s.failures.some((f) => f.kind === 'bad-config'), 'the host refused its own settings');
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

  it('propagates normalized session scope and both display preferences', async () => {
    const include = join(process.env.GC_TEST_HOME, 'Scope', 'Work');
    const exclude = join(include, 'Private');
    const directory = (value) => process.platform === 'win32' ? value.replace(/\\/g, '/').toLowerCase() : value;
    const preferences = {
      includeRepositories: ['https://github.com/Example/Repo.git'],
      excludeRepositories: ['git@github.com:Personal/Notes.git'],
      includeDirectories: [include],
      excludeDirectories: [exclude],
      showHistory: false,
      showAdHoc: false,
    };
    const expected = {
      ...preferences,
      includeRepositories: ['github.com/example/repo'],
      excludeRepositories: ['github.com/personal/notes'],
      includeDirectories: [directory(include)],
      excludeDirectories: [directory(exclude)],
    };

    for (const [key, value] of Object.entries(preferences)) {
      await settings().update(`sessions.${key}`, value, vscode.ConfigurationTarget.Global);
    }
    const selected = await untilStored((c) => SESSION_SCOPE_KEYS.every((key) => JSON.stringify(c.sessionScope?.[key]) === JSON.stringify(expected[key])),
      'session scope preferences did not reach the shared hub');
    assert.deepStrictEqual(selected.sessionScope, expected);

    for (const key of SESSION_SCOPE_KEYS) {
      await settings().update(`sessions.${key}`, undefined, vscode.ConfigurationTarget.Global);
    }
    const restored = await untilStored((c) => c.sessionScope?.showHistory === true && c.sessionScope.showAdHoc === true &&
      ['includeRepositories', 'excludeRepositories', 'includeDirectories', 'excludeDirectories'].every((key) => c.sessionScope[key]?.length === 0),
      'clearing session preferences did not restore the defaults');
    assert.deepStrictEqual(restored.agents, [{ id: 'claude', path: 'claude-not-on-this-path' }]);
  });

  it('refuses relative session scope directories instead of accepting ambiguous rules', async () => {
    const badScope = (s) => s.failures.some((f) => f.kind === 'bad-config' && f.message.includes('sessionScope'));
    await settings().update('sessions.includeDirectories', ['relative-folder'], vscode.ConfigurationTarget.Global);
    await untilSnapshot(badScope, 'invalid session scope was not refused');
    await settings().update('sessions.includeDirectories', [], vscode.ConfigurationTarget.Global);
    await untilSnapshot((s) => !badScope(s), 'corrected session scope remained refused');
  });

  it('keeps action agent and model independent of triage and discovery configuration', async () => {
    await settings().update('agents', { claude: 'claude-not-on-this-path', codex: 'codex-not-on-this-path' }, vscode.ConfigurationTarget.Global);
    await settings().update('triage.model', 'classifier-one', vscode.ConfigurationTarget.Global);
    await settings().update('actions.agent', 'codex', vscode.ConfigurationTarget.Global);
    await settings().update('actions.permissionMode', 'dontAsk', vscode.ConfigurationTarget.Global);
    await settings().update('actions.model', 'coding-model', vscode.ConfigurationTarget.Global);
    const selected = await untilStored((c) => c.triage?.model === 'classifier-one' && c.actions?.agent === 'codex' && c.actions.model === 'coding-model' && c.actions.permissionMode === 'dontAsk',
      'separate action and triage settings did not reach the hub');
    assert.deepStrictEqual(selected.agents, [{ id: 'claude', path: 'claude-not-on-this-path' }, { id: 'codex', path: 'codex-not-on-this-path' }]);

    await settings().update('triage.model', 'classifier-two', vscode.ConfigurationTarget.Global);
    await untilStored((c) => c.triage?.model === 'classifier-two' && c.actions?.model === 'coding-model' && c.agents.every((agent) => agent.model === undefined),
      'changing triage modified action or discovery models');
    await settings().update('actions.model', '', vscode.ConfigurationTarget.Global);
    await untilStored((c) => c.actions?.model === '' && c.triage?.model === 'classifier-two', 'empty action model did not clear the explicit selection');
  });

  it('reports absent classification for Codex-only settings and clears it when Claude is restored', async () => {
    await settings().update('agents', { codex: 'codex-not-on-this-path' }, vscode.ConfigurationTarget.Global);
    await untilSnapshot((s) => s.triage?.canRequest === false && s.triage.message.includes('No enabled agent'),
      'Codex-only settings did not explain missing classification');
    await settings().update('agents', OFFLINE_AGENTS, vscode.ConfigurationTarget.Global);
    await untilSnapshot((s) => s.triage?.canRequest === true, 'restoring Claude did not clear missing capability');
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
