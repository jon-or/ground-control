const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const vscode = require('vscode');

/**
 * What only a real extension host settles about the Changes control. The fold itself is `changesPlan`, tested in
 * `packages/host-vscode`; here the three mechanisms it rides on are exercised against a real worktree, all of them
 * version-fragile and recorded as such in `docs/mechanics.md` §30:
 *
 * - `git.openRepository` opens a checkout outside this window's folder, given a path rather than a URI;
 * - the repository VS Code then answers with is that worktree, not the window's own — the failure the refusal
 *   exists for is silent, because a miss returns the window's only repository without prompting;
 * - `_workbench.openMultiDiffEditor` opens a tab from a `git:` original and a `file:` modified.
 */
describe('the changes editor, against a real worktree', () => {
  const REMOTE = 'https://github.com/example-org/example-repo.git';
  let scratch;
  let clone;
  let worktree;
  let base;
  let warned = [];
  let originalWarn;
  let originalInfo;

  function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  }

  before(async function () {
    this.timeout(60_000);
    await vscode.extensions.getExtension('ownerrez.ground-control').activate();

    scratch = mkdtempSync(join(tmpdir(), 'gc-changes-'));
    clone = join(scratch, 'repo');
    worktree = join(scratch, 'repo.worktrees', '18941-inbox-badge');
    mkdirSync(clone, { recursive: true });

    git(clone, 'init', '--initial-branch=main');
    git(clone, 'config', 'user.email', 'board@example.invalid');
    git(clone, 'config', 'user.name', 'Board');
    // A remote so the base ladder has `origin/main` to find. Nothing is ever fetched from it.
    git(clone, 'remote', 'add', 'origin', REMOTE);
    writeFileSync(join(clone, 'kept.txt'), 'one\n');
    writeFileSync(join(clone, 'removed.txt'), 'gone soon\n');
    writeFileSync(join(clone, 'staged.txt'), 'staged\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'base');
    // `origin/main` without a network: the ref is written by hand to the commit the branch is on.
    git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

    git(clone, 'worktree', 'add', '-b', '18941-inbox-badge', worktree);
    writeFileSync(join(worktree, 'kept.txt'), 'one\ntwo\n');
    writeFileSync(join(worktree, 'added.txt'), 'new file\n');
    rmSync(join(worktree, 'removed.txt'));
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'committed work');
    // Left uncommitted, so the editor has to span both halves to hold it at all.
    writeFileSync(join(worktree, 'dirty.txt'), 'not committed\n');

    // Staged and then deleted on disk: the index says modified and the working tree says gone. One status per path
    // keeps whichever was read last, and this must come out a deletion rather than a row pointing at nothing.
    writeFileSync(join(worktree, 'staged.txt'), 'staged and edited\n');
    git(worktree, 'add', 'staged.txt');
    rmSync(join(worktree, 'staged.txt'));

    // A committed file renamed in the index: one row from its name at the base to the name it has now, not two.
    git(worktree, 'mv', 'kept.txt', 'renamed.txt');

    base = git(worktree, 'merge-base', 'HEAD', 'origin/main');

    originalWarn = vscode.window.showWarningMessage;
    originalInfo = vscode.window.showInformationMessage;
    vscode.window.showWarningMessage = (message) => (warned.push(message), Promise.resolve(undefined));
    vscode.window.showInformationMessage = (message) => (warned.push(message), Promise.resolve(undefined));
  });

  after(async () => {
    vscode.window.showWarningMessage = originalWarn;
    vscode.window.showInformationMessage = originalInfo;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Git may still hold a handle on Windows. The runner's own sweep takes what is left.
    }
  });

  beforeEach(() => {
    warned = [];
  });

  it('opens the worktree as a repository and diffs that one, not the window own', async function () {
    this.timeout(60_000);

    await vscode.commands.executeCommand('groundControl.openChanges', worktree, '#18941 Inbox badge');

    assert.deepStrictEqual(warned, [], `the board refused: ${warned.join(' | ')}`);

    const api = vscode.extensions.getExtension('vscode.git').exports.getAPI(1);
    const opened = api.repositories.map((repository) => repository.rootUri.fsPath);

    assert.ok(
      opened.some((root) => root.toLowerCase() === worktree.toLowerCase()),
      `the worktree never joined the repository list: ${opened.join(', ')}`,
    );
    assert.strictEqual(
      api.getRepository(vscode.Uri.file(worktree)).rootUri.fsPath.toLowerCase(),
      worktree.toLowerCase(),
    );
  });

  it('opens one editor holding the committed work and the uncommitted work together', async function () {
    this.timeout(60_000);

    await vscode.commands.executeCommand('groundControl.openChanges', worktree, '#18941 Inbox badge');

    assert.deepStrictEqual(warned, [], `the board refused: ${warned.join(' | ')}`);

    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;

    assert.ok(tab, 'nothing opened');

    // The editor appends its own count to the title it was given, so this is VS Code counting the resources it
    // accepted rather than the board repeating what it sent: four files, the three committed and the one dirty.
    // added.txt, removed.txt, dirty.txt, staged.txt and the rename of kept.txt — five, whichever half each came
    // from. `staged.txt` is the one that only appears if the index and the working tree were read separately.
    assert.strictEqual(tab.label, '#18941 Inbox badge — since ' + base.slice(0, 7) + ' (5 files)');

    // Only a row with both sides is reported back, so this is the renamed file; an addition and a deletion each
    // have one side and are counted above rather than listed here.
    const pairs = (tab.input.textDiffs ?? []).map((diff) => [diff.original, diff.modified]);

    assert.strictEqual(pairs.length, 1, `expected one two-sided row, got ${pairs.length}`);

    const [original, modified] = pairs[0];

    // The left-hand side is the merge base under the name the file had there, the right-hand side is the file on
    // disk under the name it has now. A rename that started a second row would leave two pairs, not one.
    assert.strictEqual(original.scheme, 'git');
    assert.strictEqual(JSON.parse(original.query).ref, base);
    assert.ok(original.fsPath.endsWith('kept.txt'), original.fsPath);
    assert.strictEqual(modified.scheme, 'file');
    assert.ok(modified.fsPath.endsWith('renamed.txt'), modified.fsPath);

    // The silent failure this whole path is arranged against: both sides inside the worktree, never the clone it
    // was made from.
    for (const uri of [original, modified]) {
      assert.ok(uri.fsPath.toLowerCase().startsWith(worktree.toLowerCase()), `${uri.fsPath} is outside ${worktree}`);
    }
  });

  it('says so rather than opening an editor when the directory is not a checkout', async function () {
    this.timeout(30_000);

    await vscode.commands.executeCommand('groundControl.openChanges', scratch, '#18941 Inbox badge');

    assert.strictEqual(warned.length, 1, `expected one refusal, got: ${warned.join(' | ')}`);
    assert.match(warned[0], /not inside a Git checkout/);
  });
});
