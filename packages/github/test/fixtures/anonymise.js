// Scrub all fixtures together to preserve account mappings.
// GC_SELF_LOGINS=<comma-separated logins> node test/fixtures/anonymise.js
const fs = require('node:fs');
const path = require('node:path');
const { title } = require('../../../../tools/fixture-words.js');

const REPO = 'example-org/example-repo';

/** Map each account consistently. Configured accounts become dev-1 and its bot/alternate variants. */
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

      // Preserve synthetic logins when re-scrubbing.
      if (/^dev-\d+(-[a-z0-9-]+)?$/.test(login)) {
        map.set(login, login);

        return login;
      }

      others++;
      const replacement = `dev-${others}`;
      map.set(login, replacement);

      return replacement;
    },
    /** Original-to-synthetic login pairs for leak checks. */
    pairs: () => [...map.entries()],
  };
}

/** Project owners become example-org, then other-org, other-org-2, in order of appearance, keeping who owns what. */
function ownerMap() {
  const map = new Map();

  return {
    of(login) {
      if (/^(example-org|other-org(-\d+)?)$/.test(login)) {
        return login;
      }

      if (!map.has(login)) {
        map.set(login, map.size === 0 ? 'example-org' : map.size === 1 ? 'other-org' : `other-org-${map.size}`);
      }

      return map.get(login);
    },
  };
}

/** Owner logins in project items and timeline events that the scrubber has not replaced. */
function recordedOwner(project) {
  const login = project?.owner?.login;

  return login && !/^(example-org|other-org(-\d+)?)$/.test(login) ? login : null;
}

/** Select assigned-search and by-number issue nodes. projectItems distinguishes them from triage context handled by anonymise-context.js. */
function issueNodesOf(response) {
  const issue = response?.data?.repository?.issue;

  return [...(response?.data?.cards?.nodes ?? []), ...(issue?.projectItems ? [issue] : [])];
}

/** Replace identifying fields while preserving the recorded GraphQL structure. */
function anonymiseResponse(response, logins, owners = ownerMap()) {
  const nodes = issueNodesOf(response);

  for (const node of nodes) {
    node.title = title(node.number);
    node.url = `https://github.com/${REPO}/issues/${node.number}`;

    for (const item of node.projectItems?.nodes ?? []) {
      if (item.project?.owner?.login) {
        item.project.owner.login = owners.of(item.project.owner.login);
      }
    }

    if (node.repository) {
      node.repository.nameWithOwner = REPO;
    }

    for (const pr of node.pullRequests?.nodes ?? []) {
      pr.url = `https://github.com/${REPO}/pull/${pr.number}`;
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

/** Reject remaining identifying values before writing; tests consume only scrubbed fixtures. */
function assertScrubbed(recorded, written, logins) {
  const json = JSON.stringify(written);
  const identifyingActorValues = (actor) =>
    actor && !/^dev-\d+(-[a-z0-9-]+)?$/.test(actor.login) ? [actor.login, actor.avatarUrl] : [];

  const fromNodes = recorded.flatMap((r) =>
    issueNodesOf(r).flatMap((n) => [
      n.title === title(n.number) ? null : n.title,
      n.repository?.nameWithOwner === REPO ? null : n.repository?.nameWithOwner,
      ...(n.projectItems?.nodes ?? []).map((item) => recordedOwner(item.project)),
      ...(n.assignees?.nodes ?? []).flatMap(identifyingActorValues),
      ...(n.pullRequests?.nodes ?? []).flatMap((pr) => [
        pr.url?.startsWith(`https://github.com/${REPO}/`) ? null : pr.url,
        ...identifyingActorValues(pr.author),
      ]),
    ]),
  );

  // Exclude synthetic values when checking a second scrub pass.
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
    console.log(f, `${issueNodesOf(written[i]).length} nodes`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { REPO, anonymiseResponse, issueNodesOf, loginMap, ownerMap, recordedOwner, title };
