// Re-records `git-reads.json` from checkouts on this machine: `node test/fixtures/record.js <checkout> [<checkout>...]`.
// Give it at least one worktree and one plain clone, or the link tests lose a case. Read the diff before committing.
const fs = require('node:fs');
const path = require('node:path');
const { anonymise } = require('./anonymise.js');

const norm = (p) => p.split('\\').join('/');
const cwds = process.argv.slice(2);

if (cwds.length === 0) {
  console.error('usage: node test/fixtures/record.js <checkout> [<checkout>...]');
  process.exit(1);
}

// Record .git, HEAD, and referenced gitdirs. Null means a read failed, including text reads of a clone .git directory.
const reads = {};

const record = (p) => {
  try {
    reads[norm(p)] = fs.readFileSync(p, 'utf8');
  } catch {
    reads[norm(p)] = null;
  }
};

for (const cwd of cwds) {
  const dotGit = path.join(cwd, '.git');
  record(dotGit);

  const pointer = reads[norm(dotGit)];
  const gitdir = pointer && /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
  record(path.join(gitdir ? path.resolve(cwd, gitdir) : dotGit, 'HEAD'));
}

const clean = anonymise(cwds, reads);

fs.writeFileSync(path.join(__dirname, 'git-reads.json'), `${JSON.stringify(clean, null, 2)}\n`);
console.log(`git-reads.json ${Object.keys(clean).length} reads for ${cwds.length} checkouts`);
