// Record DETAIL_QUERY responses and scrub them. Element structure and attributes are kept, because the panel is
// tested against GitHub's markup shapes; every run of text is replaced, because bodies are private.
// Usage, from packages/github:
//   GC_SELF_LOGINS=<gh logins> GC_DETAIL_REPO=owner/name node test/fixtures/record-detail.js <issue> [<pr>]
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { remark, title } = require('../../../../tools/fixture-words.js');

const here = __dirname;
const REPO = process.env.GC_DETAIL_REPO ?? '';
const [owner = '', name = ''] = REPO.split('/');

/** Read a shipped query so a recording cannot drift from the document the board sends, expanding its `${NAME}` parts. */
function shippedQuery(wanted) {
  const source = readFileSync(join(here, '..', '..', 'src', 'queries.ts'), 'utf8');
  const consts = new Map();

  for (const [, constant, text] of source.matchAll(/const ([A-Z_]+) = `([\s\S]*?)`;/g)) {
    consts.set(constant, text);
  }

  const match = new RegExp(String.raw`export const ${wanted} = \`([\s\S]*?)\`;`).exec(source);

  if (!match) {
    throw new Error(`${wanted} was not found in src/queries.ts — the recorder reads the shipped document.`);
  }

  let query = match[1];

  for (let pass = 0; pass < 5 && query.includes('${'); pass += 1) {
    query = query.replace(/\$\{([A-Z_]+)\}/g, (whole, constant) => consts.get(constant) ?? whole);
  }

  if (query.includes('${')) {
    throw new Error(`${wanted} still holds an unresolved reference: ${/\$\{[A-Z_]+\}/.exec(query)?.[0]}`);
  }

  return query;
}

function run(query, vars) {
  return JSON.parse(
    execFileSync(
      'gh',
      [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        ...Object.entries(vars).flatMap(([key, value]) => [typeof value === 'string' ? '-f' : '-F', `${key}=${String(value)}`]),
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ),
  );
}

/** Record one subject, then page its timeline backwards the way the adapter does, newest page first. */
function record(number, subject) {
  const issue = subject === 'issue';
  const address = { owner, name, number: Number(number), issue, pr: !issue };
  const raw = run(shippedQuery('DETAIL_QUERY'), address);
  const item = issue ? raw.data.repository.issue : raw.data.repository.pullRequest;
  let events = item.timelineItems.pageInfo;

  for (let read = 1; read < 20 && events.hasPreviousPage; read += 1) {
    const more = run(shippedQuery('DETAIL_EVENTS_QUERY'), { ...address, events: events.startCursor });
    const paged = (issue ? more.data.repository.issue : more.data.repository.pullRequest).timelineItems;

    item.timelineItems.nodes.unshift(...paged.nodes);
    events = paged.pageInfo;
  }

  item.timelineItems.pageInfo = events;

  return raw;
}

/** Replace every run of text between tags, keeping tags, attributes, and whitespace-only runs. */
function scrubHtml(html, number, seed) {
  let index = seed;

  return html.replace(/>([^<]+)</g, (whole, text) => {
    if (text.trim() === '') {
      return whole;
    }

    index += 1;
    const words = remark(number, index).replace(/[#*_`>\-\n]/g, ' ').split(/\s+/).filter(Boolean);
    const wanted = Math.max(1, Math.min(words.length, Math.ceil(text.trim().split(/\s+/).length / 2)));

    return `>${words.slice(0, wanted).join(' ')}<`;
  });
}

/** Keep link and image shapes without keeping addresses; the panel only checks scheme and rendering. */
function scrubAttributes(html) {
  return html
    .replace(/href="[^"]*"/g, 'href="https://github.com/example-org/example-repo/issues/1"')
    .replace(/src="[^"]*"/g, 'src="https://private-user-images.githubusercontent.com/1/example.png?jwt=scrubbed"')
    .replace(/(alt|title|aria-label)="[^"]*"/g, '$1="example"')
    // Heading anchors are `id="user-content-<heading slug>"`, which is the heading's own words.
    .replace(/(id|name)="[^"]*"/g, '$1="example"')
    // GitHub puts cross-reference addresses in data attributes. Keep the attributes, so the panel's sanitizer is
    // tested against them, and replace the values, which name the recording repository.
    .replace(/(data-[a-z-]+)="[^"]*"/g, '$1="example"');
}

function scrubBody(html, number, seed) {
  return scrubAttributes(scrubHtml(html ?? '', number, seed));
}

const logins = new Map();

function loginFor(login) {
  if (login === null || login === undefined) {
    return login;
  }

  const own = (process.env.GC_SELF_LOGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);

  if (own.includes(login)) {
    return 'dev-1';
  }

  if (!logins.has(login)) {
    logins.set(login, `dev-${logins.size + 2}`);
  }

  return logins.get(login);
}

function scrubActor(actor) {
  return actor === null || actor === undefined
    ? (actor ?? null)
    : { login: loginFor(actor.login), avatarUrl: 'https://avatars.githubusercontent.com/u/1?s=40' };
}

/** Trim collections to the recorded shape the tests need; a trimmed page reports that more remains to fetch. */
const KEPT_EVENTS = 24;
const KEPT_THREADS = 3;

/** Fields the recorder knows how to scrub. An added API field must be handled here, not carried through unseen. */
const ITEM_FIELDS = [
  'number', 'title', 'url', 'state', 'createdAt', 'bodyHTML', 'lastEditedAt', 'author', 'reactionGroups', 'assignees',
  'milestone', 'labels', 'isDraft', 'reviewDecision', 'baseRefName', 'headRefName', 'commits',
  'timelineItems', 'reviewThreads',
];
const THREAD_FIELDS = ['path', 'line', 'originalLine', 'isResolved', 'isOutdated', 'comments'];

/** Event fields carrying private words. Everything else on an event is an enum, a count, a login, or a timestamp. */
const WORDED = new Set(['bodyHTML', 'messageHeadline', 'previousTitle', 'currentTitle', 'dismissalMessage', 'milestoneTitle']);

function checkFields(node, known, what) {
  const unknown = Object.keys(node).filter((field) => !known.includes(field));

  if (unknown.length > 0) {
    throw new Error(`the query returned ${what} fields this recorder cannot scrub: ${unknown.join(', ')}`);
  }
}

/** Walk an event, replacing prose, logins, repository names, and addresses wherever they sit in its shape. */
function scrubEvent(node, number, seed) {
  const walk = (value, key) => {
    if (Array.isArray(value)) {
      return value.map((entry) => walk(entry, key));
    }

    if (value === null || typeof value !== 'object') {
      if (typeof value === 'string' && WORDED.has(key)) {
        return key === 'bodyHTML' ? scrubBody(value, number, seed) : title(number + seed + key.length);
      }

      return value;
    }

    const out = {};

    for (const [field, entry] of Object.entries(value)) {
      if (field === 'label') {
        // A label name is project taxonomy, like the item's own labels, not a person.
        out[field] = entry === null ? null : { name: 'area-1' };
      } else if (field === 'login' || field === 'slug') {
        out[field] = typeof entry === 'string' ? loginFor(entry) : entry;
      } else if (field === 'name' && typeof entry === 'string') {
        out[field] = loginFor(entry);
      } else if (field === 'avatarUrl') {
        out[field] = 'https://avatars.githubusercontent.com/u/1?s=40';
      } else if (field === 'nameWithOwner') {
        out[field] = 'example-org/example-repo';
      } else if (field === 'url') {
        out[field] = 'https://github.com/example-org/example-repo/issues/1';
      } else {
        out[field] = walk(entry, field);
      }
    }

    return out;
  };

  return walk(node, '');
}

function scrubComment(comment, number, seed) {
  return { ...comment, bodyHTML: scrubBody(comment.bodyHTML, number, seed), author: scrubActor(comment.author) };
}

/** Thread paths name private source files; keep the extension, which is all the panel displays differently. */
function scrubThreads(threads, number) {
  if (!threads) {
    return threads;
  }

  return {
    // Trimming to the newest threads leaves older ones unread, which is what the panel reports.
    pageInfo: { hasPreviousPage: threads.nodes.length > KEPT_THREADS, startCursor: null },
    nodes: threads.nodes.slice(-KEPT_THREADS).map((thread, i) => {
      checkFields(thread, THREAD_FIELDS, 'review thread');
      const extension = /\.[A-Za-z0-9]+$/.exec(thread.path)?.[0] ?? '';

      return {
        ...thread,
        path: `src/example-${i + 1}${extension}`,
        comments: {
          pageInfo: thread.comments.pageInfo,
          nodes: thread.comments.nodes.map((comment, j) => scrubComment(comment, number, 300 + i * 20 + j)),
        },
      };
    }),
  };
}

/** Keep the recent tail plus the first of every earlier event kind, so a fixture covers the shapes the mapper reads. */
function keptEvents(item) {
  const nodes = item.timelineItems.nodes;
  const tail = Math.max(0, nodes.length - KEPT_EVENTS);
  const seen = new Set();

  return nodes.filter((node, at) => {
    if (at >= tail) {
      return true;
    }

    const first = !seen.has(node.__typename);
    seen.add(node.__typename);

    return first;
  });
}

function scrubItem(item, subject) {
  if (!item) {
    return item;
  }

  checkFields(item, ITEM_FIELDS, 'item');

  return {
    ...item,
    title: title(item.number),
    url: `https://github.com/example-org/example-repo/${subject === 'issue' ? 'issues' : 'pull'}/${item.number}`,
    bodyHTML: scrubBody(item.bodyHTML, item.number, 0),
    author: scrubActor(item.author),
    assignees: { nodes: (item.assignees?.nodes ?? []).map((who) => ({ login: loginFor(who.login) })) },
    milestone: item.milestone === null ? null : { title: 'Patch 1' },
    // Label names are project taxonomy; keep the count and colors, replace the words.
    labels: {
      nodes: item.labels.nodes.map((label, i) => ({ name: `${['area', 'kind', 'stage', 'risk'][i % 4]}-${i + 1}`, color: label.color })),
    },
    ...(item.baseRefName ? { baseRefName: 'main', headRefName: 'topic-branch' } : {}),
    // A trimmed timeline reports older entries left unread, so the panel's clipped-conversation path is exercised.
    timelineItems: {
      pageInfo: { hasPreviousPage: keptEvents(item).length < item.timelineItems.nodes.length, startCursor: null },
      nodes: keptEvents(item).map((node, i) => scrubEvent(node, item.number, 400 + i * 7)),
    },
    ...(item.reviewThreads ? { reviewThreads: scrubThreads(item.reviewThreads, item.number) } : {}),
  };
}

function write(file, raw, subject) {
  const repository = raw.data.repository;
  const scrubbed = {
    data: {
      repository: {
        nameWithOwner: 'example-org/example-repo',
        ...(subject === 'issue'
          ? { issue: scrubItem(repository.issue, 'issue') }
          : { pullRequest: scrubItem(repository.pullRequest, 'pull-request') }),
      },
    },
  };

  const text = `${JSON.stringify(scrubbed, null, 2)}\n`;

  // Refuse to write a fixture that still names the recording repository, its people, an address, or a local path.
  const refuse = [
    ...[owner, name, ...(process.env.GC_SELF_LOGINS ?? '').split(',')].map((value) => value.trim()).filter(Boolean),
    // Windows paths in either drive-letter case, POSIX home paths, and email addresses.
    String.raw`[A-Za-z]:\\\\`,
    String.raw`/(?:home|Users)/`,
    String.raw`[\w.+-]+@[\w-]+\.[\w.]+`,
  ];

  for (const secret of refuse) {
    const at = text.search(new RegExp(secret, 'i'));

    if (at !== -1) {
      throw new Error(`the scrubbed fixture still contains ${secret}: …${text.slice(Math.max(0, at - 120), at + 120)}…`);
    }
  }

  writeFileSync(join(here, file), text);
  console.log(`${file}: ${text.length} bytes`);
}

const [issueNumber, prNumber] = process.argv.slice(2);

if (!REPO || !issueNumber) {
  throw new Error('set GC_DETAIL_REPO and pass an issue number, or `-` to keep the recorded one');
}

// `-` keeps a recorded file, so one subject can be re-recorded without disturbing the other.
if (issueNumber !== '-') {
  write('detail-issue.json', record(issueNumber, 'issue'), 'issue');
}

if (prNumber && prNumber !== '-') {
  write('detail-pull-request.json', record(prNumber, 'pull-request'), 'pull-request');
}
