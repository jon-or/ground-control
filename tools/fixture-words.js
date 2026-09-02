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

module.exports = { PROBLEMS, SUBJECTS, pick, title };
