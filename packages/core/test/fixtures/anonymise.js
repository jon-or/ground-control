// Scrub every recording using the shared fixture vocabulary; manual edits would be lost on re-recording.
const { assertNoAbsolutePaths, checkoutMap, gitReadsFor, identifyingReads, HOME, REPO } = require('../../../../tools/fixture-scrub.js');

/** Synthetic prefixes every path in the fixture must start with. A real one that survived would not match any. */
const SYNTHETIC = [HOME, REPO, 'd:/work', 'c:/users/dev'];

/** Reject unsanitized recordings before writing; tests only see the saved, scrubbed output. */
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
