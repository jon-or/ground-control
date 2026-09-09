// Record live roster and transcript fixtures with node test/fixtures/record.js after CLI format changes. Review
// the diff before committing.
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

// Read .git and HEAD for each session checkout, including worktree gitdirs. A clone's .git directory returns
// null from a text read.
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

// Apply anonymise.js to every recording; see README.md for preserved structure.
const dirs = fs.readdirSync(projectsRoot);

// Use the reader's TITLE_TAIL_BYTES limit; tests check recorder and reader agreement.
const TITLE_TAIL_BYTES = 64 * 1024;

/**
 * Record ordered title records from the final 64 kB and the last title's distance from EOF. Exclude
 * conversation text; tests reconstruct synthetic tails.
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
