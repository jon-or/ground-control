// Re-records these fixtures by running the real readers against the live machine, so the output is what the two
// packages actually produced: `npm run build --workspaces && node test/fixtures/record.js`.
const fs = require('node:fs');
const path = require('node:path');
const { fetchAssignedIssues } = require('@ground-control/github');
const { diskReaders, fetchSessions } = require('@ground-control/core');
const { makeClaudeAdapter } = require('@ground-control/agent-claude');
const { anonymiseIssues, anonymiseSessions, assertScrubbed } = require('./anonymise.js');

const here = __dirname;

const write = (name, value) => {
  fs.writeFileSync(path.join(here, name), JSON.stringify(value, null, 2) + '\n');
  console.log(name, Array.isArray(value) ? `${value.length} entries` : 'written');
};

async function main() {
  const issues = await fetchAssignedIssues({
    ghPath: 'gh',
    // From the environment, so a public repo carries no one's account or repository name.
    repo: process.env.GC_RECORD_REPO ?? 'owner/repo',
    logins: (process.env.GC_RECORD_LOGINS ?? '').split(',').filter(Boolean),
    projectNumber: Number(process.env.GC_RECORD_PROJECT ?? 1),
    cardSource: 'project',
    maxPages: 5,
  });

  if (!issues.ok) {
    throw new Error(`${issues.error.kind}: ${issues.error.message}`);
  }

  const sessions = await fetchSessions(
    { agents: [{ id: 'claude', path: 'claude' }], branchIssuePattern: '^(\\d+)-' },
    [makeClaudeAdapter()],
    diskReaders(),
  );

  if (sessions.failures.length > 0) {
    throw new Error(sessions.failures.map((f) => `${f.subject}/${f.kind}: ${f.message}`).join('; '));
  }

  const clean = {
    issues: anonymiseIssues(issues.value.cards),
    sessions: anonymiseSessions(sessions.sessions),
  };

  assertScrubbed({ issues: issues.value.cards, sessions: sessions.sessions }, clean);

  write('issues.json', clean.issues);
  write('sessions.json', clean.sessions);

  const onBoard = new Set(issues.value.cards.map((c) => c.number));
  const linked = sessions.sessions.filter((s) => s.issueNumber !== null);

  console.log(`linked to an issue on the board: ${linked.filter((s) => onBoard.has(s.issueNumber)).length}`);
  console.log(`linked to an issue that is not: ${linked.filter((s) => !onBoard.has(s.issueNumber)).length}`);
  console.log(`unlinked: ${sessions.sessions.length - linked.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
