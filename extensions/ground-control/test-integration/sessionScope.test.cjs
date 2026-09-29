const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { Module } = require('node:module');
const { join } = require('node:path');
const { buildSync } = require('esbuild');
const vscode = require('vscode');

describe('session scope at editor execution', () => {
  const settings = () => vscode.workspace.getConfiguration('groundControl');
  let entry;
  let createTerminal;
  let executeCommand;
  let terminals;
  let commands;
  let session;

  before(() => {
    const extension = vscode.extensions.getExtension('groundcontrol.ground-control');
    const outfile = join(process.env.GC_TEST_HOME, 'session-scope-entry.cjs');
    buildSync({
      stdin: {
        contents: "export { attachTo } from './src/attach.ts'; export { performRoute, boardRoot } from './src/resident.ts';",
        resolveDir: extension.extensionPath,
      },
      outfile, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'],
    });
    // VS Code assigns API instances by importing extension. Reuse this test's real API so its execution
    // stubs also cover the temporary bundle, which is outside the extension directory.
    const loaded = new Module(outfile, module);
    loaded.filename = outfile;
    loaded.paths = module.paths;
    loaded.require = (id) => id === 'vscode' ? vscode : require(id);
    loaded._compile(readFileSync(outfile, 'utf8'), outfile);
    entry = loaded.exports;
    createTerminal = vscode.window.createTerminal;
    executeCommand = vscode.commands.executeCommand;
    session = {
      agent: 'claude', sessionId: 'a1b2c3d4-0000-4000-8000-000000000000', attachId: 'test-attach', pid: 4242,
      title: 'Private work', cwd: entry.boardRoot(), checkoutRoot: entry.boardRoot(), startedAt: 1,
      branch: '42-private-work', repository: 'github.com/example-org/example-repo', issueNumber: 42,
      transcriptWrittenAt: null, activity: null, finished: false, details: {},
    };
    assert.ok(session.cwd, 'the isolated test workspace must be open');
  });

  beforeEach(() => {
    terminals = [];
    commands = [];
    vscode.window.createTerminal = (options) => {
      terminals.push(options);
      return { show() {} };
    };
    vscode.commands.executeCommand = async (...args) => {
      commands.push(args);
      throw new Error('test command observed');
    };
  });

  afterEach(async () => {
    vscode.window.createTerminal = createTerminal;
    vscode.commands.executeCommand = executeCommand;
    for (const key of ['excludeRepositories', 'includeDirectories', 'showHistory', 'showAdHoc']) {
      await settings().update(`sessions.${key}`, undefined, vscode.ConfigurationTarget.Global);
    }
  });

  const live = async () => ({ allowed: true, targetActive: true, cardActive: true });
  const saved = async () => ({ allowed: true, targetActive: false, cardActive: false });
  const denied = async () => ({ allowed: false, targetActive: false, cardActive: false });
  const resume = () => ({ route: 'resume-here', session, root: session.cwd, expiresAt: Date.now() + 60_000 });

  it('attaches only while both shared authorization and current application preferences allow it', async () => {
    assert.equal(await entry.attachTo(session, live), true);
    assert.equal(terminals.length, 1);
    assert.deepEqual(terminals[0].shellArgs, ['attach', 'test-attach']);

    assert.equal(await entry.attachTo(session, denied), false);
    await settings().update('sessions.excludeRepositories', ['example-org/example-repo'], vscode.ConfigurationTarget.Global);
    assert.equal(await entry.attachTo(session, live), false);
    assert.equal(terminals.length, 1);
  });

  it('rechecks preferences after an attach authorization response was delayed', async () => {
    let release;
    const pending = entry.attachTo(session, () => new Promise((resolve) => { release = resolve; }));
    await settings().update('sessions.excludeRepositories', ['example-org/example-repo'], vscode.ConfigurationTarget.Global);
    release(await live());
    assert.equal(await pending, false);
    assert.equal(terminals.length, 0);
  });

  it('fails closed on malformed local scope and hidden ad-hoc work', async () => {
    await settings().update('sessions.includeDirectories', ['relative-folder'], vscode.ConfigurationTarget.Global);
    assert.equal(await entry.attachTo(session, live), false);
    await settings().update('sessions.includeDirectories', [], vscode.ConfigurationTarget.Global);
    await settings().update('sessions.showAdHoc', false, vscode.ConfigurationTarget.Global);
    assert.equal(await entry.attachTo({ ...session, issueNumber: null }, live), false);
    assert.equal(terminals.length, 0);
  });

  it('requires authoritative safety even when the projected roster is empty', async () => {
    const plan = resume();
    const failure = await entry.performRoute(plan, async () => [], async () => ({ allowed: true, targetActive: false, cardActive: true }));
    assert.match(failure, /no longer be opened safely/);
    assert.equal(commands.length, 0);

    const allowed = await entry.performRoute(plan, async () => [], saved);
    assert.match(allowed, /test command observed/);
    assert.equal(commands.length, 1, 'an authorized saved session must reach the editor command');
  });

  /** A window opened for a resume restores its Claude tabs, and one can resume the session before the handover arrives. */
  it('reports a resume the window already restored instead of refusing it, running no command', async () => {
    const reopened = [{ ...session, attachId: null }];
    const info = vscode.window.showInformationMessage;
    const shown = [];
    vscode.window.showInformationMessage = (message) => (shown.push(message), Promise.resolve(undefined));

    try {
      const failure = await entry.performRoute(resume(), async () => reopened, live);

      assert.equal(failure, null);
      assert.equal(commands.length, 0, 'a restored session must not be opened a second time');
      assert.match(shown[0], /is already open in /);

      // The tab can register while the route checks scope and profile, after its first roster read.
      let reads = 0;
      const late = await entry.performRoute(resume(), async () => (reads++ === 0 ? [] : reopened), saved);
      assert.equal(late, null);
      assert.equal(commands.length, 0, 'a session restored during the checks must not be opened a second time');

      const elsewhere = await entry.performRoute(resume(), async () => [{ ...reopened[0], cwd: 'd:/elsewhere' }], live);
      assert.match(elsewhere, /no longer be opened safely/);
    } finally {
      vscode.window.showInformationMessage = info;
    }
  });

  /**
   * A browser start carries no extension readiness, so the hub plans one assuming it and the window that
   * performs the start is the one that has to check. This host has no Claude extension installed.
   */
  it('refuses a start whose agent extension is not in this window, running no command', async () => {
    const plan = { route: 'start-session', key: 'issue:42', agent: 'claude', root: entry.boardRoot(), prompt: null };

    const failure = await entry.performRoute(plan, async () => [], saved);

    assert.match(failure, /The claude extension is not available/);
    assert.equal(commands.length, 0, 'a start must not reach the editor command without its extension');
  });

  /**
   * The recheck the hub delegates to the performing window, because a page request states no workspace
   * (M51). It runs before the extension check, so a drifted window is refused without an activation wait.
   */
  it('refuses a start whose window has moved off the checkout, running no command', async () => {
    const plan = { route: 'start-session', key: 'issue:42', agent: 'claude', root: 'd:/not-this-window', prompt: null };

    const failure = await entry.performRoute(plan, async () => [], saved);

    assert.match(failure, /This window is no longer on d:\/not-this-window/);
    assert.equal(commands.length, 0, 'a start must not reach the editor command from the wrong folder');
  });

  /**
   * The half the package tests cannot reach: turning a placement into a real editor call. `{kind:'absent'}`
   * must arrive as `undefined` and `{kind:'text'}` must unwrap to the prompt (M51).
   */
  it('starts in this window with the placement arguments the editor command expects', async () => {
    const extensions = vscode.extensions.getExtension;

    vscode.extensions.getExtension = (id) =>
      String(id).toLowerCase() === 'anthropic.claude-code'
        ? { isActive: true, activate: async () => undefined }
        : extensions(id);

    try {
      const plan = { route: 'start-session', key: 'issue:42', agent: 'claude', root: entry.boardRoot(), prompt: 'Fix the paging' };
      const failure = await entry.performRoute(plan, async () => [], saved);

      assert.match(failure, /test command observed/, 'the start must reach the editor command');
      assert.equal(commands.length, 1);
      // The absent session slot becomes undefined rather than an object, and the prompt arrives unwrapped.
      assert.deepEqual(commands[0], ['claude-vscode.primaryEditor.open', undefined, 'Fix the paging']);
    } finally {
      vscode.extensions.getExtension = extensions;
    }
  });

  describe('with claudeSessionLocation set to preferred', () => {
    const preferred = { programmatic: 'honor-preferred-location' };
    let getConfiguration;
    let getExtension;
    let claudePrefers;
    let shown;
    let info;

    beforeEach(async () => {
      await settings().update('claudeSessionLocation', 'preferred', vscode.ConfigurationTarget.Global);
      // This host has no Claude extension, so its setting is not registered and cannot be written.
      getConfiguration = vscode.workspace.getConfiguration;
      vscode.workspace.getConfiguration = (section, ...rest) =>
        section === 'claudeCode' ? { get: (key) => (key === 'preferredLocation' ? claudePrefers : undefined) } : getConfiguration(section, ...rest);
      getExtension = vscode.extensions.getExtension;
      vscode.extensions.getExtension = (id) =>
        String(id).toLowerCase() === 'anthropic.claude-code' ? { isActive: true, activate: async () => undefined } : getExtension(id);
      vscode.commands.executeCommand = async (...args) => {
        commands.push(args);
      };
      shown = [];
      info = vscode.window.showInformationMessage;
      vscode.window.showInformationMessage = (message) => (shown.push(message), Promise.resolve(undefined));
    });

    afterEach(async () => {
      vscode.workspace.getConfiguration = getConfiguration;
      vscode.extensions.getExtension = getExtension;
      vscode.window.showInformationMessage = info;
      await settings().update('claudeSessionLocation', undefined, vscode.ConfigurationTarget.Global);
    });

    /** A sidebar open adds no tab, so the tab check that fails an editor resume must not run (M63). */
    it('resumes in the sidebar Claude prefers, without waiting for a tab', async () => {
      claudePrefers = 'sidebar';

      const failure = await entry.performRoute(resume(), async () => [], saved);

      assert.equal(failure, null);
      assert.deepEqual(commands, [['claude-vscode.editor.open', session.sessionId, undefined, undefined, undefined, undefined, preferred]]);
    });

    it('resumes in an editor tab while Claude prefers the panel, and reports the tab that never came', async () => {
      claudePrefers = 'panel';

      const failure = await entry.performRoute(resume(), async () => [], saved);

      assert.match(failure, /no tab appeared/);
      assert.deepEqual(commands, [['claude-vscode.primaryEditor.open', session.sessionId]]);
    });

    it('starts a prefilled session in the sidebar', async () => {
      claudePrefers = 'sidebar';
      const plan = { route: 'start-session', key: 'issue:42', agent: 'claude', root: entry.boardRoot(), prompt: 'Fix the paging' };

      assert.equal(await entry.performRoute(plan, async () => [], saved), null);
      assert.deepEqual(commands, [['claude-vscode.editor.open', undefined, 'Fix the paging', undefined, undefined, undefined, preferred]]);
    });

    /** The sidebar switches back to the session's running process instead of only being focused (M63). */
    it('switches the sidebar to a session it holds, with no guidance message', async () => {
      claudePrefers = 'sidebar';

      const failure = await entry.performRoute({ route: 'sidebar-here', session, root: session.cwd }, async () => [], live);

      assert.equal(failure, null);
      assert.deepEqual(commands, [['claude-vscode.editor.open', session.sessionId, undefined, undefined, undefined, undefined, preferred]]);
      assert.deepEqual(shown, []);
    });

    /** With Claude preferring a tab, opening a sidebar session by ID would start a second process (M6). */
    it('only focuses the sidebar while Claude prefers the panel', async () => {
      claudePrefers = 'panel';

      const failure = await entry.performRoute({ route: 'sidebar-here', session, root: session.cwd }, async () => [], live);

      assert.equal(failure, null);
      assert.deepEqual(commands, [['claudeVSCodeSidebarSecondary.focus']]);
      assert.match(shown[0], /sidebar should be showing/);
    });
  });

  it('refuses resume after history is hidden while the roster read is pending', async () => {
    let release;
    let reading;
    const started = new Promise((resolve) => { reading = resolve; });
    const pending = entry.performRoute(resume(), () => {
      reading();
      return new Promise((resolve) => { release = resolve; });
    }, saved);
    await Promise.race([started, pending.then((failure) => { throw new Error(`Resume returned before reading the roster: ${failure}`); })]);
    await settings().update('sessions.showHistory', false, vscode.ConfigurationTarget.Global);
    release([]);
    const failure = await pending;
    assert.match(failure, /hidden by the current session settings/);
    assert.ok(!failure.includes(session.cwd) && !failure.includes(session.sessionId));
    assert.equal(commands.length, 0);
  });

  it('refuses shared authorization revocation before revealing a live session', async () => {
    const failure = await entry.performRoute({ route: 'reveal-here', session, root: session.cwd }, async () => [], denied);
    assert.match(failure, /hidden by the current session settings/);
    assert.equal(commands.length, 0);
  });

  it('hides an editor error containing excluded details after settings change during execution', async () => {
    let rejectCommand;
    let executing;
    const started = new Promise((resolve) => { executing = resolve; });
    vscode.commands.executeCommand = () => {
      executing();
      return new Promise((_resolve, reject) => { rejectCommand = reject; });
    };
    const pending = entry.performRoute({ route: 'reveal-here', session, root: session.cwd }, async () => [], live);
    await Promise.race([started, pending.then((failure) => { throw new Error(`Reveal returned before executing the command: ${failure}`); })]);
    await settings().update('sessions.excludeRepositories', ['example-org/example-repo'], vscode.ConfigurationTarget.Global);
    rejectCommand(new Error(`Could not reveal ${session.sessionId} in ${session.cwd}`));
    const failure = await pending;
    assert.match(failure, /hidden by the current session settings/);
    assert.ok(!failure.includes(session.cwd) && !failure.includes(session.sessionId));
  });
});
