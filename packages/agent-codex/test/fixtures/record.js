// Writes `hook-payloads.json` from a capture, scrubbed. README.md carries the capture itself, which is interactive:
// a Codex hook payload only exists inside a session, and Codex will not run a hook it has not been told to trust.
//
//   node record.js <captured.ndjson>
//
// The capture is one JSON payload per line, in the order Codex fired them — the file a probe hook appends its stdin
// to. Scrubbing runs here rather than by hand, because a hand-scrub is undone by the next recording.
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { anonymise } = require('./anonymise.js');

const capture = process.argv[2];

if (!capture) {
  console.error('usage: node record.js <captured.ndjson>');
  process.exit(2);
}

const payloads = readFileSync(capture, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const scrubbed = anonymise(payloads);

writeFileSync(join(__dirname, 'hook-payloads.json'), `${JSON.stringify(scrubbed, null, 2)}\n`);
console.log(`wrote ${scrubbed.length} scrubbed payloads: ${scrubbed.map((p) => p.hook_event_name).join(', ')}`);
