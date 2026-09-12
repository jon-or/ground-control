// Record CUSTODY_QUERY pages for one issue and scrub them. Logins, the title, the repository, and the project
// owner are replaced; numbers, timestamps, statuses, cursors, and `wasAutomated` are kept, because the legs are
// derived from them (docs/testing.md). Machine logins named in GC_BOT_LOGINS become bot-1, bot-2, … so tests can
// configure them as bots; a login ending in `[bot]` is a public app and is kept.
// Usage, from packages/github:
//   GC_SELF_LOGINS=<gh logins> GC_BOT_LOGINS=<bot logins> GC_DETAIL_REPO=owner/name node test/fixtures/record-custody.js <issue> <fixture name>
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { title } = require('../../../../tools/fixture-words.js');
const { loginMap, ownerMap } = require('./anonymise.js');

const here = __dirname;
const REPO = process.env.GC_DETAIL_REPO ?? '';
const [owner = '', name = ''] = REPO.split('/');

function shippedQuery() {
  const source = readFileSync(join(here, '..', '..', 'src', 'queries.ts'), 'utf8');
  const match = /export const CUSTODY_QUERY = `([\s\S]*?)`;/.exec(source);

  if (!match) {
    throw new Error('CUSTODY_QUERY was not found in src/queries.ts — the recorder reads the shipped document.');
  }

  return match[1];
}

function run(vars) {
  return JSON.parse(
    execFileSync(
      'gh',
      ['api', 'graphql', '-f', `query=${shippedQuery()}`, ...Object.entries(vars).flatMap(([key, value]) => [typeof value === 'string' ? '-f' : '-F', `${key}=${String(value)}`])],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ),
  );
}

/** Record every page the adapter would read, oldest first. */
function record(number) {
  const pages = [];
  let after = null;

  for (let read = 0; read < 10; read += 1) {
    const page = run(after === null ? { owner, name, number } : { owner, name, number, after });

    pages.push(page);

    const info = page.data.repository.issue.timelineItems.pageInfo;

    if (!info.hasNextPage) {
      break;
    }

    after = info.endCursor;
  }

  return pages;
}

function scrub(pages, number) {
  const people = loginMap((process.env.GC_SELF_LOGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  const bots = (process.env.GC_BOT_LOGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const owners = ownerMap();
  const logins = {
    of: (login) => (login.endsWith('[bot]') ? login : bots.includes(login) ? `bot-${bots.indexOf(login) + 1}` : people.of(login)),
  };

  for (const page of pages) {
    const issue = page.data.repository.issue;

    issue.title = title(number);
    issue.url = `https://github.com/example-org/example-repo/issues/${number}`;

    for (const node of issue.timelineItems.nodes) {
      if (node?.actor) {
        node.actor.login = logins.of(node.actor.login);
      }

      if (node?.assignee?.login) {
        node.assignee.login = logins.of(node.assignee.login);
      }

      if (node?.project?.owner?.login) {
        node.project.owner.login = owners.of(node.project.owner.login);
      }
    }
  }

  return pages;
}

const [, , issue, fixture] = process.argv;

if (!REPO || !issue || !fixture) {
  console.error('Usage: GC_SELF_LOGINS=<logins> GC_DETAIL_REPO=owner/name node test/fixtures/record-custody.js <issue> <fixture name>');
  process.exit(1);
}

const number = Number(issue);
const pages = scrub(record(number), number);

writeFileSync(join(here, `${fixture}.json`), `${JSON.stringify(pages, null, 2)}\n`);
console.log(`${fixture}.json: ${pages.length} page(s), ${pages.reduce((sum, page) => sum + page.data.repository.issue.timelineItems.nodes.length, 0)} nodes`);
