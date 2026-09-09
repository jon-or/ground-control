const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { Module } = require('node:module');
const { join } = require('node:path');
const { buildSync } = require('esbuild');
const vscode = require('vscode');

describe('agent storage at editor execution', () => {
  let entry;
  let createTerminal;
  let executeCommand;
  let environment;
  let terminals;
  let commands;
  let session;
  const profile = (name) => join(process.env.GC_TEST_HOME, name).replace(/\\/g, '/');

  before(() => {
    const extension = vscode.extensions.getExtension('groundcontrol.ground-control');
    const outfile = join(process.env.GC_TEST_HOME, 'agent-storage-entry.cjs');
    buildSync({
      stdin: {
        contents: "export { attachTo } from './src/attach.ts'; export { performRoute, boardRoot } from './src/resident.ts'; export { editorAgentHomes } from './src/agentStorage.ts';",
        resolveDir: extension.extensionPath,
      },
      outfile, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'],
    });
    const loaded = new Module(outfile, module);
    loaded.filename = outfile;
    loaded.paths = module.paths;
    loaded.require = (id) => id === 'vscode' ? vscode : require(id);
    loaded._compile(readFileSync(outfile, 'utf8'), outfile);
    entry = loaded.exports;
    session = {
      agent: 'claude', sessionId: 'a1b2c3d4-0000-4000-8000-000000000000', attachId: 'test-attach', pid: 4242,
      title: 'Test work', cwd: entry.boardRoot(), checkoutRoot: entry.boardRoot(), startedAt: 1,
      branch: '42-test-work', repository: 'github.com/example-org/example-repo', issueNumber: 42,
      transcriptWrittenAt: null, activity: null, finished: false, details: {},
    };
  });

  beforeEach(() => {
    createTerminal = vscode.window.createTerminal;
    executeCommand = vscode.commands.executeCommand;
    environment = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
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

  afterEach(() => {
    vscode.window.createTerminal = createTerminal;
    vscode.commands.executeCommand = executeCommand;
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('sends both selected agent roots and preserves invalid values for configuration refusal', () => {
    process.env.CLAUDE_CONFIG_DIR = profile('claude-work');
    process.env.CODEX_HOME = profile('codex-work');
    assert.deepEqual(entry.editorAgentHomes(), { claude: profile('claude-work'), codex: profile('codex-work') });
    process.env.CLAUDE_CONFIG_DIR = 'relative-profile';
    assert.equal(entry.editorAgentHomes().claude, 'relative-profile');
  });

  it('attaches with the accepted profile even when the editor inherited a different one', async () => {
    process.env.CLAUDE_CONFIG_DIR = profile('editor-profile');
    const allowed = await entry.attachTo(session, async () => ({
      allowed: true, targetActive: true, cardActive: true, agentHome: profile('accepted-profile'),
    }));
    assert.equal(allowed, true);
    assert.equal(terminals.length, 1);
    assert.deepEqual(terminals[0].env, { CLAUDE_CONFIG_DIR: profile('accepted-profile') });
    assert.equal(process.env.CLAUDE_CONFIG_DIR, profile('editor-profile'));
    assert.equal(await entry.attachTo(session, async () => ({
      allowed: true, targetActive: true, cardActive: true, agentHome: 'relative-profile',
    })), false);
    assert.equal(terminals.length, 1);
  });

  it('refuses mismatched reveal and new-session profiles before invoking editor commands', async () => {
    process.env.CLAUDE_CONFIG_DIR = profile('editor-profile');
    const check = async () => ({ allowed: true, targetActive: true, cardActive: true, agentHome: profile('hub-profile') });
    const refusal = await entry.performRoute({ route: 'reveal-here', session, root: session.cwd }, async () => [], check);
    assert.match(refusal, /Restart VS Code with CLAUDE_CONFIG_DIR/);
    const start = await entry.performRoute({ route: 'start-session', agent: 'claude', key: 'issue:42', root: session.cwd, prompt: null, agentHome: profile('hub-profile') }, async () => [], check);
    assert.match(start, /Restart VS Code with CLAUDE_CONFIG_DIR/);
    assert.equal(commands.length, 0);
  });

  it('uses current accepted profile after a held check and permits a matching editor', async () => {
    process.env.CLAUDE_CONFIG_DIR = profile('editor-profile');
    let release;
    let checking;
    const started = new Promise((resolve) => { checking = resolve; });
    const plan = { route: 'reveal-here', session, root: session.cwd };
    const pending = entry.performRoute(plan, async () => [], () => {
      checking();
      return new Promise((resolve) => { release = resolve; });
    });
    await Promise.race([started, pending.then(() => { throw new Error('route returned before profile check'); })]);
    release({ allowed: true, targetActive: true, cardActive: true, agentHome: profile('changed-profile') });
    assert.match(await pending, /Restart VS Code with CLAUDE_CONFIG_DIR/);
    assert.equal(commands.length, 0);
    const failure = await entry.performRoute(plan, async () => [], async () => ({
      allowed: true, targetActive: true, cardActive: true, agentHome: profile('editor-profile'),
    }));
    assert.match(failure, /test command observed/);
    assert.equal(commands.length, 1);
  });
});
