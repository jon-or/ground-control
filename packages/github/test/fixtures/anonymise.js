// This repo is going public, so recorded responses name no real issue, account or repository. Run over every fixture
// in one pass — a hand-scrub of one file drifts from the others, and a login has to mean the same person in all of
// them: `GC_SELF_LOGINS=<your gh logins> node test/fixtures/anonymise.js`.
const fs = require('node:fs');
const path = require('node:path');
const { title } = require('../../../../tools/fixture-words.js');

const REPO = 'example-org/example-repo';

/**
 * One synthetic login per real one, so two cards assigned to the same person still look like it. The accounts the
 * board is for come first and keep their relationship — `dev-1` and its `dev-1-bot` — because the fixtures only make
 * sense if the configured login is one of the assignees.
 */
function loginMap(selfLogins) {
  const map = new Map();
  const [first, ...rest] = selfLogins;
  let others = 1;

  if (first) {
    map.set(first, 'dev-1');
  }

  rest.forEach((login, i) => map.set(login, `dev-1-${['bot', 'alt', 'third'][i] ?? `alt-${i}`}`));

  return {
    of(login) {
      const known = map.get(login);

      if (known) {
        return known;
      }

      // Already synthetic — a second run over scrubbed fixtures must not renumber everyone.
      if (/^dev-\d+(-[a-z0-9-]+)?$/.test(login)) {
        map.set(login, login);

        return login;
      }

      others++;
      const replacement = `dev-${others}`;
      map.set(login, replacement);

      return replacement;
    },
    /** The real logins met so far, paired with what replaced them, for the leak check. */
    pairs: () => [...map.entries()],
  };
}

/** Walks the recorded GraphQL shape, rewriting only the fields that spell out real work. */
function anonymiseResponse(response, logins) {
  const nodes = response?.data?.cards?.nodes ?? [];

  for (const node of nodes) {
    node.title = title(node.number);
    node.url = `https://github.com/${REPO}/issues/${node.number}`;

    if (node.repository) {
      node.repository.nameWithOwner = REPO;
    }

    for (const actor of [
      ...(node.assignees?.nodes ?? []),
      ...(node.pullRequests?.nodes ?? []).map((pr) => pr.author).filter(Boolean),
    ]) {
      actor.login = logins.of(actor.login);

      if (actor.avatarUrl) {
        actor.avatarUrl = `https://avatars.githubusercontent.com/${actor.login}?s=40`;
      }
    }
  }

  return response;
}

/**
 * Fails the run rather than leaving a fixture that still names something real. The tests cannot catch this — they
 * only ever see anonymised output, so an anonymiser that stopped scrubbing would leave them green.
 */
function assertScrubbed(recorded, written, logins) {
  const json = JSON.stringify(written);
  const identifyingActorValues = (actor) =>
    actor && !/^dev-\d+(-[a-z0-9-]+)?$/.test(actor.login) ? [actor.login, actor.avatarUrl] : [];

  const fromNodes = recorded.flatMap((r) =>
    (r?.data?.cards?.nodes ?? []).flatMap((n) => [
      n.title === title(n.number) ? null : n.title,
      n.repository?.nameWithOwner === REPO ? null : n.repository?.nameWithOwner,
      ...(n.assignees?.nodes ?? []).flatMap(identifyingActorValues),
      ...(n.pullRequests?.nodes ?? []).flatMap((pr) => identifyingActorValues(pr.author)),
    ]),
  );

  // A value the anonymiser itself produces is not a leak — that is what a second run over scrubbed files reads back.
  const real = [...fromNodes, ...logins.pairs().filter(([from, to]) => from !== to).map(([from]) => from)].filter(
    (value) => typeof value === 'string' && value.length > 3,
  );

  const leaked = [...new Set(real)].filter((value) => json.includes(value));

  if (leaked.length > 0) {
    throw new Error(`anonymise left ${leaked.length} identifying value(s) in the fixtures: ${leaked.slice(0, 5).join(', ')}`);
  }
}

function main() {
  const here = __dirname;
  const files = fs.readdirSync(here).filter((f) => f.endsWith('.json')).sort();
  const logins = loginMap((process.env.GC_SELF_LOGINS ?? '').split(',').filter(Boolean));

  const recorded = files.map((f) => JSON.parse(fs.readFileSync(path.join(here, f), 'utf8')));
  const written = recorded.map((r) => anonymiseResponse(structuredClone(r), logins));

  assertScrubbed(recorded, written, logins);

  files.forEach((f, i) => {
    fs.writeFileSync(path.join(here, f), JSON.stringify(written[i], null, 2) + '\n');
    console.log(f, `${written[i]?.data?.cards?.nodes?.length ?? 0} nodes`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { REPO, anonymiseResponse, loginMap, title };
