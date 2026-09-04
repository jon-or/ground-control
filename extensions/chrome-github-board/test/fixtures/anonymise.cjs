// This repo is public, so the recorded board carries no real issue, repository, project item or column name. Applied
// by `record.cjs` on every recording: a hand-scrub would be undone by the next one.
const { title } = require('../../../../tools/fixture-words.js');
const { assertNoAbsolutePaths } = require('../../../../tools/fixture-scrub.js');

const REPO = 'example-org/example-repo';

/** The issues the fixture carries. Fixed, because the tests name them, and the recorder maps real cards onto them. */
const ISSUES = [4501, 4502, 4503];

/** Neutral names for the two columns kept. The overlay reads neither; a recorded one would still name a real board. */
const COLUMNS = ['Backlog', 'In progress'];

/** What each synthetic issue is called. One vocabulary across packages, so 4501 reads the same everywhere. */
function titles() {
  return ISSUES.map((number) => title(number));
}

/**
 * The words the fixture is allowed to contain. Everything else that reads as prose is somebody's, and free text is
 * replaced wholesale rather than matched — no list of ids will ever cover an issue title or a label.
 */
const ALLOWED = new Set([
  ...COLUMNS,
  ...titles(),
  ...ISSUES.map((number) => `${REPO.split('/')[1]} #${number}`),
  'Project board',
  'Click a value to filter the view',
  'Fields',
]);

/** Every attribute and text node a person could have written into. Anything not enumerated is a leak by default. */
const FREE_TEXT = /(?:aria-label|title|alt|placeholder|data-hovercard-url)="([^"]*)"|>([^<>{}]{4,})</g;

/**
 * Everything the recorder replaced, asserted gone — and then the harder half `docs/testing.md` asks for: that
 * nothing of the shape being scrubbed survives at all, whether or not the recorder knew to look for it. A recording
 * carries names nobody enumerated, and the first loop can only ever find what the recorder already found.
 */
function assertScrubbed(html, recorded) {
  for (const value of recorded) {
    if (String(value).length > 2 && html.includes(String(value))) {
      throw new Error(`anonymise left a recorded value in the fixture: ${value}`);
    }
  }

  for (const [, slug] of html.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\//g)) {
    if (slug !== REPO) {
      throw new Error(`anonymise left a real repository in the fixture: ${slug}`);
    }
  }

  for (const [, number] of html.matchAll(/\/issues\/(\d+)/g)) {
    if (!ISSUES.includes(Number(number))) {
      throw new Error(`anonymise left a real issue number in the fixture: ${number}`);
    }
  }

  for (const [, id] of html.matchAll(/data-board-card-id="(\d+)"/g)) {
    if (!ISSUES.includes(Number(id) - 20_000)) {
      throw new Error(`anonymise left a real project item id in the fixture: ${id}`);
    }
  }

  for (const [, attribute, text] of html.matchAll(FREE_TEXT)) {
    const value = (attribute ?? text ?? '').trim();
    // Entities out first, or `&nbsp;` reads as the word it is spelled with and every count in the markup is a leak.
    const words = value.replace(/&[a-z]+;/g, ' ').trim();

    // A word, rather than markup or a number: a label, an assignee's name, a title the trim left behind.
    if (words.length > 3 && /[a-z]{4}/i.test(words) && !ALLOWED.has(value)) {
      throw new Error(`anonymise left free text in the fixture: ${value}`);
    }
  }

  assertNoAbsolutePaths(html, []);
}

module.exports = { COLUMNS, ISSUES, REPO, assertScrubbed, titles };
