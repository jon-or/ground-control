// The synthetic issue vocabulary the fixture anonymisers share. This repo is going public, so no recorded fixture
// carries a real issue title; one word list keeps the same issue number reading the same across packages.
const SUBJECTS = [
  'booking export',
  'inbox badge',
  'payment retry',
  'listing sync',
  'guest portal',
  'tax rule',
  'quote email',
  'calendar feed',
  'review import',
  'refund ledger',
  'channel mapping',
  'owner statement',
];

const PROBLEMS = [
  'drops rows past the first page',
  'counts archived records twice',
  'ignores the account time zone',
  'retries a settled charge',
  'sends before the template renders',
  'rounds the wrong currency unit',
  'overwrites a manual edit',
  'skips the second occurrence',
  'reads across the tenant boundary',
  'fails silently on an empty result',
];

/**
 * What a comment says, for the triage fixtures. A recorded conversation is nothing but free text written by named
 * colleagues, so every body is replaced wholesale rather than matched (`docs/testing.md`). The structure the tests
 * turn on survives — who wrote it, in what order, whether a thread is resolved — because only the words are rebuilt.
 */
const REMARKS = [
  'Reproduced on the second page of results; the first page is fine.',
  'This still fails for me after the latest deploy.',
  'Can you confirm which account this was tested against?',
  'Left a couple of notes on the diff — mostly naming.',
  'The fix looks right, but it needs a test for the empty case.',
  'Should this respect the account time zone, or the property one?',
  'Verified in UAT, the totals line up now.',
  'Blocked on the other change landing first.',
  'I think we settled on the second approach in the design review.',
  'Rebased and pushed; checks are green again.',
];

/** Stable per number, so re-recording the same issue produces the same text and the diff stays readable. */
function pick(list, number, salt) {
  let hash = salt;

  for (const digit of String(number)) {
    hash = (hash * 31 + Number(digit)) % 100_003;
  }

  return list[hash % list.length];
}

function title(number) {
  const subject = pick(SUBJECTS, number, 7);

  return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${pick(PROBLEMS, number, 13)}`;
}

/**
 * A synthetic comment or body. `index` is the position within its own list, so two comments on one issue never read
 * the same and a test can tell the third from the first. `minLength` pads by repeating whole remarks, which is how a
 * fixture carries a body long enough to exercise clipping without anybody writing 2 KB of prose by hand.
 */
function remark(number, index, minLength = 0) {
  let text = `${pick(REMARKS, number + index * 17, 5)} (${pick(SUBJECTS, number + index, 3)})`;

  for (let i = 1; text.length < minLength; i++) {
    text += ` ${pick(REMARKS, number + index * 17 + i, 11)}`;
  }

  return text;
}

module.exports = { PROBLEMS, REMARKS, SUBJECTS, pick, remark, title };
