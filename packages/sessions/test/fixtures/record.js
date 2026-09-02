// Re-records every fixture in this directory from the live machine: `node test/fixtures/record.js`.
// Run it when a CLI's output shape changes. Read the diff before committing — a fixture is evidence.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { anonymise } = require('./anonymise.js');

const here = __dirname;
const norm = (p) => p.split('\\').join('/');
const home = norm(os.homedir());
const projectsRoot = `${home}/.claude/projects`;

const write = (name, value) => {
  fs.writeFileSync(path.join(here, name), JSON.stringify(value, null, 2) + '\n');
  console.log(name, Array.isArray(value) ? `${value.length} entries` : 'written');
};

const claude = (args) => JSON.parse(execFileSync('claude', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));

const active = claude(['agents', '--json']);
const all = claude(['agents', '--all', '--json']);

// One `.git` and one `HEAD` per distinct checkout the live sessions are running in, plus the worktree gitdirs they
// point at. A null value is a real read failure — a plain `.git` is a directory, so reading it as text fails.
const reads = {};

const record = (p) => {
  try {
    reads[norm(p)] = fs.readFileSync(p, 'utf8');
  } catch {
    reads[norm(p)] = null;
  }
};

for (const cwd of new Set(active.map((s) => s.cwd))) {
  const dotGit = path.join(cwd, '.git');
  record(dotGit);

  const pointer = reads[norm(dotGit)];
  const gitdir = pointer && /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
  record(path.join(gitdir ? path.resolve(cwd, gitdir) : dotGit, 'HEAD'));
}

// Everything below is written through `anonymise.js`: this repo is public, and a recording names real checkouts,
// branches and a home directory. See README.md for what the anonymiser preserves.
const dirs = fs.readdirSync(projectsRoot);

const entries = active.map((s) => {
  const slug = s.cwd.replace(/[^A-Za-z0-9]/g, '-');
  const lowered = slug.toLowerCase();
  const candidates = [...dirs.filter((d) => d === slug), ...dirs.filter((d) => d !== slug && d.toLowerCase() === lowered)];

  let dir = null;
  let writtenAt = null;

  for (const candidate of candidates) {
    try {
      const stats = fs.statSync(`${projectsRoot}/${candidate}/${s.sessionId}.jsonl`);

      if (stats.isFile()) {
        dir = candidate;
        writtenAt = Math.round(stats.mtimeMs);
        break;
      }
    } catch {
      /* try the next case variant */
    }
  }

  return { name: s.name ?? null, cwd: s.cwd, sessionId: s.sessionId, dir, writtenAt };
});

const clean = anonymise({ active, all, reads, transcripts: { home, projectDirs: dirs, entries } });

write('agents-active.json', clean.active);
write('agents-all.json', clean.all);
write('git-reads.json', clean.reads);
write('transcripts.json', clean.transcripts);

const present = clean.transcripts.entries.filter((e) => e.writtenAt !== null);

console.log(`sessions: ${clean.active.length} active, ${clean.all.length} with --all`);
console.log(`transcripts present: ${present.length} of ${clean.transcripts.entries.length}`);
console.log(`oldest write among live sessions: ${((Date.now() - Math.min(...present.map((e) => e.writtenAt))) / 3_600_000).toFixed(1)}h ago`);
