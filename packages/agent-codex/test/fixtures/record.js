// Write scrubbed hook-payloads.json with node record.js <captured.ndjson>. Supply one raw payload per line in
// capture order. README.md describes capture and hook trust setup.
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
