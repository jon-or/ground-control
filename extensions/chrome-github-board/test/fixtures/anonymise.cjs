// Scrub issue, repository, project-item, and column names on every recording to keep public fixtures
// anonymous.
const { title } = require('../../../../tools/fixture-words.js');
const { assertNoAbsolutePaths } = require('../../../../tools/fixture-scrub.js');

const REPO = 'example-org/example-repo';

/** The issues the fixture carries. Fixed, because the tests name them, and the recorder maps real cards onto them. */
const ISSUES = [4501, 4502, 4503];

/** Add recorded assignee stacks to two cards; leave the third unassigned. */
const ASSIGNED = [4501, 4502];

/**
 * Use synthetic assignees and data-URI avatars so rendering fixtures cannot request external images
 * (docs/testing.md).
 */
const ASSIGNEE = 'example-dev';

/** The fixture is a board filtered to the viewer, the state the overlay is built for (R36). */
const FILTER = `assignee:${ASSIGNEE}`;
const AVATAR = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

/** Neutral names for the two columns kept. The overlay reads neither; a recorded one would still name a real board. */
const COLUMNS = ['Backlog', 'In progress'];

/** What the recorded project and its view tabs are called. A real board's name and views are the team's own words. */
const PROJECT = 'Example project';
const VIEWS = ['Board', 'Table'];

/** What each synthetic issue is called. One vocabulary across packages, so 4501 reads the same everywhere. */
function titles() {
  return ISSUES.map((number) => title(number));
}

/** Allow only known synthetic prose; replace all other free text, including issue titles and labels. */
const ALLOWED = new Set([
  ...COLUMNS,
  ...VIEWS,
  PROJECT,
  ...titles(),
  ...ISSUES.map((number) => `${REPO.split('/')[1]} #${number}`),
  'Project board',
  'Click a value to filter the view',
  'Filter by keyword or by field',
  'Fields',
  'View',
  'View filters',
  'Discard',
  'Project',
  'Select view',
  ASSIGNEE,
  `Assignees: ${ASSIGNEE}`,
]);

/** Every attribute and text node a person could have written into. Anything not enumerated is a leak by default. */
const FREE_TEXT = /(?:aria-label|title|alt|placeholder|data-hovercard-url)="([^"]*)"|>([^<>{}]{4,})</g;

/**
 * Assert removed values are absent, then check for unexpected sensitive patterns not explicitly captured by
 * the recorder (docs/testing.md).
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

  /*
   * Allow only synthetic issue-link URLs and data-URI assets. Validate each URL-bearing attribute to prevent
   * network requests during rendering (docs/testing.md).
   */
  for (const [, attribute, url] of html.matchAll(/\b(src|srcset|href|poster|data-src)="(https?:[^"]*)"/g)) {
    if (!url.startsWith(`https://github.com/${REPO}/issues/`)) {
      throw new Error(`anonymise left an address the fixture would fetch: ${attribute}="${url}"`);
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

module.exports = { ASSIGNED, ASSIGNEE, AVATAR, COLUMNS, FILTER, ISSUES, PROJECT, REPO, VIEWS, assertScrubbed, titles };
