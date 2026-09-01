const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Window-scoped seize probe. Each VS Code window runs its own extension host, so this file's
// executeCommand always acts on THIS window — that is the property under test.

const ROOT = path.join(os.homedir(), '.factory');
const INBOX = path.join(ROOT, 'inbox');
const REGISTRY = path.join(ROOT, 'windows.json');
const LOG = path.join(ROOT, 'seize-probe.log');
const SEIZED = path.join(ROOT, 'seized.json');
const EVENTS = path.join(ROOT, 'events');

// A tab holds its session: resuming while it is open forks a copy. So the release path retries
// until the resume reports the original id back, rather than assuming close == released.
const HANDBACK_ATTEMPTS = 6;
const HANDBACK_DELAY_MS = 1500;

function log(msg) {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()}  ${msg}${os.EOL}`);
  } catch { /* diagnostics must never break a seize */ }
}

function folder() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri.fsPath : null;
}

// Same slug shape Claude Code uses for its project dirs: lowercased path, separators and colons to '-'.
function slugify(p) {
  return p.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function register(slug, dir) {
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch { /* first writer */ }
  reg[slug] = { folder: dir, pid: process.pid, updated: new Date().toISOString() };
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
}

function readSeized() {
  try { return JSON.parse(fs.readFileSync(SEIZED, 'utf8')); } catch { return {}; }
}

function writeSeized(map) {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(SEIZED, JSON.stringify(map, null, 2));
}

// Tab labels are the only handle a close event gives us, so the seize records label -> session.
function trackSeized(label, sessionId, dir, autoHandback) {
  const map = readSeized();
  map[label] = { sessionId, folder: dir, autoHandback: autoHandback !== false, seizedAt: new Date().toISOString() };
  writeSeized(map);
}

function untrackSeized(label) {
  const map = readSeized();
  delete map[label];
  writeSeized(map);
}

function emitEvent(name, body) {
  try {
    fs.mkdirSync(EVENTS, { recursive: true });
    fs.writeFileSync(path.join(EVENTS, `${name}-${Date.now()}.json`), JSON.stringify(body, null, 2));
  } catch (e) { log('emitEvent failed: ' + e.message); }
}

function runClaude(args, cwd) {
  return new Promise((resolve) => {
    execFile('claude', args, { cwd, shell: true, windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ err, out: `${stdout || ''}${stderr || ''}` });
    });
  });
}

// Resume in the background under the ORIGINAL id. "started a copy as X" means the session was still
// held — stop the copy and retry rather than leaving two agents on one worktree.
async function handBack(sessionId, dir, prompt) {
  for (let attempt = 1; attempt <= HANDBACK_ATTEMPTS; attempt++) {
    const { out } = await runClaude(['--bg', '--resume', sessionId, JSON.stringify(prompt || 'Continue.')], dir);
    const copy = /started a copy as ([0-9a-f]{8})/.exec(out);

    if (!copy) {
      log(`handback ok on attempt ${attempt}: ${out.trim().split(/\r?\n/).slice(0, 2).join(' | ')}`);
      return { ok: true, attempts: attempt };
    }

    log(`handback attempt ${attempt}: still held, stopping copy ${copy[1]}`);
    await runClaude(['stop', copy[1]], dir);
    await new Promise((r) => setTimeout(r, HANDBACK_DELAY_MS));
  }
  log(`handback FAILED after ${HANDBACK_ATTEMPTS} attempts for ${sessionId}`);
  return { ok: false, attempts: HANDBACK_ATTEMPTS };
}

async function onTabsClosed(closed, dir) {
  const map = readSeized();
  for (const tab of closed) {
    if (!tab.input || !String(tab.input.viewType || '').includes('claudeVSCodePanel')) { continue; }

    const entry = map[tab.label];
    log(`tab closed: label=${JSON.stringify(tab.label)} tracked=${!!entry}`);
    if (!entry) { continue; }

    untrackSeized(tab.label);
    emitEvent('tab-closed', { label: tab.label, sessionId: entry.sessionId, folder: entry.folder });
    if (!entry.autoHandback) { continue; }

    const started = Date.now();
    const result = await handBack(entry.sessionId, entry.folder || dir, entry.prompt);
    emitEvent('handback', { sessionId: entry.sessionId, ...result, elapsedMs: Date.now() - started });
  }
}

async function handle(file, dir) {
  let cmd;
  try { cmd = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { log('bad inbox json: ' + e.message); return; }
  if (!cmd || !cmd.sessionId) { return; }

  const before = countClaudeTabs();
  const action = cmd.action || 'seize';
  cmd._beforeTitles = claudeTabs().map((t) => t.label);
  log(`handle ${action} in window folder=${dir} session=${cmd.sessionId} claudeTabsBefore=${before} titles=${claudeTabTitles()}`);

  try {
    if (action === 'release') {
      // A tab holds the session open, and an open session cannot be handed back — a resume forks
      // instead. Releasing closes the tab so `claude --bg --resume` wakes the original.
      const match = cmd.title ? claudeTabs().filter((t) => t.label === cmd.title) : claudeTabs();
      await vscode.window.tabGroups.close(match, false);
    } else {
      await vscode.commands.executeCommand('claude-vscode.editor.open', cmd.sessionId, cmd.prompt || undefined, cmd.column);
    }
    // executeCommand resolves even when no panel appears, so count tabs rather than trust it.
    setTimeout(() => {
      const titles = claudeTabs().map((t) => t.label);
      log(`after ${action}: claudeTabs=${titles.length} titles=${JSON.stringify(titles)}`);

      if (action !== 'seize') { return; }
      const beforeTitles = new Set(cmd._beforeTitles || []);
      const created = titles.find((t) => !beforeTitles.has(t));
      if (created) {
        trackSeized(created, cmd.sessionId, dir, cmd.autoHandback);
        log(`tracked seized tab ${JSON.stringify(created)} -> ${cmd.sessionId}`);
      } else {
        log(`no new tab to track for ${cmd.sessionId} (revealed an existing one?)`);
      }
    }, 2500);
  } catch (e) {
    log(`${action} FAILED: ` + e.message);
  }
  try { fs.unlinkSync(file); } catch { /* already consumed */ }
}

function claudeTabs() {
  const out = [];
  for (const g of vscode.window.tabGroups.all) {
    for (const t of g.tabs) {
      if (t.input && t.input.viewType && String(t.input.viewType).includes('claudeVSCodePanel')) { out.push(t); }
    }
  }
  return out;
}
const countClaudeTabs = () => claudeTabs().length;
const claudeTabTitles = () => JSON.stringify(claudeTabs().map((t) => t.label));

function activate(context) {
  const dir = folder();
  if (!dir) { log('no workspace folder — not registering'); return; }

  const slug = slugify(dir);
  register(slug, dir);
  fs.mkdirSync(INBOX, { recursive: true });
  log(`activate: slug=${slug} folder=${dir} pid=${process.pid}`);

  const file = path.join(INBOX, `${slug}.json`);
  const watcher = vscode.workspace.createFileSystemWatcher(file.split(path.sep).join('/'));
  const fire = () => handle(file, dir);
  watcher.onDidCreate(fire);
  watcher.onDidChange(fire);
  context.subscriptions.push(watcher);

  // FileSystemWatcher only covers paths inside the workspace on some setups; poll as the backstop.
  const timer = setInterval(() => { if (fs.existsSync(file)) { fire(); } }, 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Closing a seized tab is the operator saying "done" — hand the session back to the factory.
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      if (e.closed && e.closed.length) { onTabsClosed(e.closed, dir); }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
