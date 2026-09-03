// This repo is public, so recorded git reads name no real checkout or branch. Applied by `record.js` on every
// recording: a hand-scrub would be undone by the next one. The vocabulary is `tools/fixture-scrub.js`, so a checkout
// reads the same here as in every other package's fixtures.
const { assertNoAbsolutePaths, checkoutMap, gitReadsFor, identifyingReads, HOME, REPO } = require('../../../../tools/fixture-scrub.js');

/** Synthetic prefixes every path in the fixture must start with. A real one that survived would not match any. */
const SYNTHETIC = [HOME, REPO, 'd:/work', 'c:/users/dev'];

/**
 * Fails the recording rather than writing a fixture that still names something real. The tests cannot catch this —
 * they only ever see anonymised output, so an anonymiser that stopped scrubbing would leave them green.
 */
function assertScrubbed(recorded, written) {
  const json = JSON.stringify(written);
  const leaked = [...new Set(identifyingReads(recorded))].filter((value) => json.includes(value));

  if (leaked.length > 0) {
    throw new Error(`anonymise left ${leaked.length} identifying value(s) in the fixture: ${leaked.slice(0, 5).join(', ')}`);
  }

  assertNoAbsolutePaths(json, SYNTHETIC);
}

/** The recorded reads rebuilt for synthetic checkouts, keeping which are worktrees and which carry an issue number. */
function anonymise(cwds, reads) {
  const written = gitReadsFor(checkoutMap(cwds, reads));

  assertScrubbed(reads, written);

  return written;
}

module.exports = { anonymise };
