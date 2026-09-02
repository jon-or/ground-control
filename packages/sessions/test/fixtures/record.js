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

// The same window the reader uses (`TITLE_TAIL_BYTES` in src/providers/claude.ts). A test holds the two to each
// other, so a recording made with a different window fails rather than quietly disagreeing with the reader.
const TITLE_TAIL_BYTES = 64 * 1024;

/**
 * The title records in a transcript's last 64 kB bytes, in order, and how far from the end the last one of the
 * whole file sits. Only the records are kept: the conversation bytes around them name real work and cannot be
 * anonymised, so the test's fake rebuilds a tail from these.
 */
function titlesIn(file) {
  const data = fs.readFileSync(file);
  const records = [];
  let lastAt = null;
  let offset = 0;

  for (const line of data.toString('utf8').split('\n')) {
    const bytes = Buffer.byteLength(line, 'utf8') + 1;

    if (line.includes('title')) {
      try {
        const parsed = JSON.parse(line);

        if (parsed.type === 'ai-title' || parsed.type === 'custom-title') {
          lastAt = data.length - offset;
          records.push({ record: parsed, fromEnd: lastAt });
        }
      } catch {
        /* not a record */
      }
    }

    offset += bytes;
  }

  return {
    records: records.filter((r) => r.fromEnd <= TITLE_TAIL_BYTES).map((r) => r.record),
    bytesFromEnd: lastAt,
  };
}

const entries = active.map((s) => {
  const slug = s.cwd.replace(/[^A-Za-z0-9]/g, '-');
  const lowered = slug.toLowerCase();
  const candidates = [...dirs.filter((d) => d === slug), ...dirs.filter((d) => d !== slug && d.toLowerCase() === lowered)];

  let dir = null;
  let writtenAt = null;
  let titles = { records: [], bytesFromEnd: null };

  for (const candidate of candidates) {
    try {
      const file = `${projectsRoot}/${candidate}/${s.sessionId}.jsonl`;
      const stats = fs.statSync(file);

      if (stats.isFile()) {
        dir = candidate;
        writtenAt = Math.round(stats.mtimeMs);
        titles = titlesIn(file);
        break;
      }
    } catch {
      /* try the next case variant */
    }
  }

  return {
    name: s.name ?? null,
    cwd: s.cwd,
    sessionId: s.sessionId,
    dir,
    writtenAt,
    titles: titles.records,
    titleBytesFromEnd: titles.bytesFromEnd,
  };
});

const clean = anonymise({ active, all, reads, transcripts: { home, projectDirs: dirs, entries } });

write('agents-active.json', clean.active);
write('agents-all.json', clean.all);
write('git-reads.json', clean.reads);
write('transcripts.json', clean.transcripts);

const present = clean.transcripts.entries.filter((e) => e.writtenAt !== null);

console.log(`sessions: ${clean.active.length} active, ${clean.all.length} with --all`);
console.log(`transcripts present: ${present.length} of ${clean.transcripts.entries.length}`);
const titled = clean.transcripts.entries.filter((e) => e.titles.length > 0);
const manual = titled.filter((e) => e.titles.some((t) => t.type === 'custom-title'));
console.log(`titles in the last ${TITLE_TAIL_BYTES / 1024}kB: ${titled.length}, of which manual: ${manual.length}`);
console.log(`oldest write among live sessions: ${((Date.now() - Math.min(...present.map((e) => e.writtenAt))) / 3_600_000).toFixed(1)}h ago`);
