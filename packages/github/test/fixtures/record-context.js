// Records the triage context fixtures from real cards and scrubs them in the same pass — a hand-scrub is undone by
// the next run, and the tests only ever see scrubbed output so they cannot catch a lapse (`docs/testing.md`).
//
//   GC_SELF_LOGINS=<your gh logins> GC_CONTEXT_REPO=owner/name \
//     node test/fixtures/record-context.js <issue>:<pr> <issue> …
//
// Each argument names a card. `<issue>:<pr>` records one with its pull request; a bare `<issue>` records one without;
// `-` leaves that file alone. The files are named by what they demonstrate, not by the issue, so re-recording against
// different cards keeps the names the tests use. Pass no arguments to re-scrub what is already on disk.
//
//   context-review    the developer's own pull request under review, with a long issue body the clip has to cut
//   context-fresh     a pull request with nothing on it yet, which is what the mergeability cases are derived from
//   context-no-pr     an issue with no pull request linked
//   context-bots      a colleague's pull request, commented on by bots
//   context-handover  a card handed over with no comment on it — the status moved, and somebody else assigned it later
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { anonymiseContext, assertContextScrubbed, loginMap } = require('./anonymise-context.js');

/** The file each recorded card becomes, in the order they are given on the command line. */
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

  // A `-` in a slot keeps that fixture as it is, so one card can be re-recorded without disturbing the rest.
  const chosen = cards.length > 0 ? NAMES.slice(0, cards.length).filter((_, i) => cards[i] !== '-') : [];
  const files = cards.length > 0 ? chosen : NAMES.filter((n) => fs.existsSync(path.join(__dirname, n)));
  const wanted = cards.filter((card) => card !== '-');

  if (cards.length > 0 && !repo) {
    throw new Error('set GC_CONTEXT_REPO=owner/name to record');
  }

  const recorded = files.map((name, i) =>
    cards.length > 0 ? record(repo, wanted[i]) : JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8')),
  );

  // One long body, so a fixture exercises clipping without anybody writing two kilobytes of prose by hand.
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
