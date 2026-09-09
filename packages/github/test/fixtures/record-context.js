// Record and scrub triage fixtures using CARD_CONTEXT_QUERY (docs/testing.md).
//
// GC_SELF_LOGINS=<logins> GC_CONTEXT_REPO=owner/name \
//   node test/fixtures/record-context.js <issue>:<pr> <issue> ...
//
// Arguments map to NAMES in order. Use issue:pr for linked PRs, issue alone otherwise,
// and - to preserve a fixture. With no arguments, re-scrub existing files.
// See README.md for fixture scenarios.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { anonymiseContext, assertContextScrubbed, loginMap } = require('./anonymise-context.js');

/** Fixture names in command-line argument order. */
const NAMES = ['context-review.json', 'context-fresh.json', 'context-no-pr.json', 'context-bots.json', 'context-handover.json'];

function query() {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'queries.ts'), 'utf8');
  const match = /export const CARD_CONTEXT_QUERY = `([\s\S]*?)`;/.exec(source);

  if (!match) {
    throw new Error('CARD_CONTEXT_QUERY was not found in src/queries.ts — the recorder reads the shipped document.');
  }

  return match[1];
}

function record(repo, card) {
  const [owner, name] = repo.split('/');
  const [issue, pr] = card.split(':');

  const out = execFileSync(
    'gh',
    [
      'api', 'graphql',
      '-f', `query=${query()}`,
      '-f', `owner=${owner}`,
      '-f', `name=${name}`,
      '-F', `issue=${issue}`,
      '-F', `pr=${pr ?? 0}`,
      '-F', `withPr=${pr !== undefined}`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  return JSON.parse(out);
}

function main() {
  const cards = process.argv.slice(2);
  const repo = process.env.GC_CONTEXT_REPO;
  const logins = loginMap((process.env.GC_SELF_LOGINS ?? '').split(',').filter(Boolean));

  if (cards.length > NAMES.length) {
    throw new Error(`this recorder names ${NAMES.length} fixtures; add a name before recording more`);
  }

  // Preserve fixtures whose argument is -.
  const chosen = cards.length > 0 ? NAMES.slice(0, cards.length).filter((_, i) => cards[i] !== '-') : [];
  const files = cards.length > 0 ? chosen : NAMES.filter((n) => fs.existsSync(path.join(__dirname, n)));
  const wanted = cards.filter((card) => card !== '-');

  if (cards.length > 0 && !repo) {
    throw new Error('set GC_CONTEXT_REPO=owner/name to record');
  }

  const recorded = files.map((name, i) =>
    cards.length > 0 ? record(repo, wanted[i]) : JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8')),
  );

  // Generate one body beyond the clipping limit.
  const written = recorded.map((response, i) =>
    anonymiseContext(structuredClone(response), logins, { longBody: files[i] === NAMES[0] }),
  );

  assertContextScrubbed(recorded, written, logins);

  files.forEach((name, i) => {
    fs.writeFileSync(path.join(__dirname, name), `${JSON.stringify(written[i], null, 2)}\n`);
    const repository = written[i]?.data?.repository;
    console.log(
      name,
      `issue ${repository?.issue?.number} · ${repository?.issue?.comments?.nodes?.length ?? 0} comments · pr ${repository?.pullRequest?.number ?? 'none'}`,
    );
  });
}

if (require.main === module) {
  main();
}
