// Record Claude hook payloads with node test/fixtures/record-hooks.js [--interactive]. Supply hooks through
// --settings without changing user settings. Review the diff before committing.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HOME } = require('./anonymise.js');

const here = __dirname;
const OUT = path.join(here, 'hook-payloads.json');

/** Record installed events and events with no mapped phase to verify the writer preserves both. */
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolBatch',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionEnd',
];

/** Events requiring interactive user input, unavailable in print mode. */
const INTERACTIVE_ONLY = ['PermissionRequest', 'PermissionDenied', 'Notification'];

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-hooks-'));
const capture = path.join(temp, 'capture.mjs');
const settings = path.join(temp, 'settings.json');
const work = path.join(temp, 'work');
const log = path.join(temp, 'log.ndjson');

fs.mkdirSync(work);
fs.writeFileSync(path.join(work, 'note.txt'), 'hello\n');
fs.writeFileSync(log, '');

fs.writeFileSync(
  capture,
  `import { appendFileSync, readFileSync } from 'node:fs';
try {
  appendFileSync(process.env.GC_CAPTURE_LOG, readFileSync(0, 'utf8').trim() + '\\n');
} catch {}
process.exit(0);
`,
);

const hooks = {};

for (const event of EVENTS) {
  hooks[event] = [{ hooks: [{ type: 'command', command: 'node', args: [capture], timeout: 15 }] }];
}

fs.writeFileSync(settings, JSON.stringify({ hooks }, null, 2));

const read = () =>
  fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

// Trigger multiple PostToolBatch events and SubagentStop with file reads, batched commands, and a subagent.
const PROMPT =
  "Read note.txt, then run 'echo one' and 'echo two' with Bash in a single message, then use the Task tool to " +
  'launch one Explore subagent that reports what note.txt says. Be brief.';

console.log('recording the non-interactive leg; this runs a real Claude session and takes a minute');

execFileSync('claude', ['--settings', settings, '--allowed-tools', 'Read,Bash,Task', '-p', PROMPT], {
  cwd: work,
  env: { ...process.env, GC_CAPTURE_LOG: log },
  stdio: 'ignore',
  timeout: 10 * 60 * 1000,
});

if (process.argv.includes('--interactive')) {
  console.log(`
The remaining events only exist in a session a human is sitting in front of: a -p run has no permission prompt to
answer. Run this in another terminal, do the five things below, then exit it and press Enter here.

  cd ${work}
  set GC_CAPTURE_LOG=${log}
  claude --settings ${settings}

  1. Submit any prompt.
  2. Let it ask to run a command, and approve it.        -> PermissionRequest, Notification:permission_prompt
  3. Ask it something so it uses AskUserQuestion.        -> PreToolUse:AskUserQuestion
  4. Put it in plan mode, then approve the plan.         -> PreToolUse:ExitPlanMode
  5. Let it ask to run a command, and deny it.           -> PermissionDenied
`);
  execFileSync(process.execPath, ['-e', 'require("fs").readSync(0, Buffer.alloc(1), 0, 1, null)'], {
    stdio: 'inherit',
  });
}

const captured = read();

/** Free-text and machine-specific fields replaced during scrubbing. */
const PROSE = new Set([
  'prompt',
  'tool_input',
  'tool_response',
  'tool_calls',
  'last_assistant_message',
  'session_crons',
  'permission_suggestions',
  'effort',
]);

const PATHS = new Set(['cwd', 'transcript_path', 'scratchpad_dir', 'agent_transcript_path']);
const IDS = new Set(['session_id', 'prompt_id', 'tool_use_id', 'agent_id']);

const ids = new Map();

const idFor = (value) => {
  if (!ids.has(value)) {
    ids.set(value, `00000000-0000-4000-8000-${String(ids.size).padStart(12, '0')}`);
  }

  return ids.get(value);
};

/**
 * Preserve fields used by the writer and replace identifying values. Keep background_tasks length with empty
 * objects because only the count is read.
 */
function scrub(payload) {
  const out = {};

  for (const [key, value] of Object.entries(payload)) {
    if (key === 'background_tasks') {
      out[key] = Array.isArray(value) ? value.map(() => ({})) : value;
      continue;
    }

    if (PATHS.has(key)) {
      out[key] = `${HOME}/recorded`;
      continue;
    }

    if (IDS.has(key)) {
      out[key] = typeof value === 'string' ? idFor(value) : value;
      continue;
    }

    if (PROSE.has(key)) {
      out[key] = Array.isArray(value) ? value.map(() => ({})) : typeof value === 'string' ? 'recorded' : {};
      continue;
    }

    out[key] = value;
  }

  return out;
}

const fresh = captured.map(scrub);
const freshEvents = new Set(fresh.map((p) => p.hook_event_name));

// Preserve previous interactive payloads when recording without --interactive so those cases remain covered.
let held = [];

try {
  held = JSON.parse(fs.readFileSync(OUT, 'utf8')).filter((p) => !freshEvents.has(p.hook_event_name));
} catch {
  // No previous recording to carry anything forward from.
}

const recorded = [...fresh, ...held];
const seen = new Set(recorded.map((p) => p.hook_event_name));
const missing = EVENTS.filter((event) => !seen.has(event));
const missingCovered = missing.filter((event) => !INTERACTIVE_ONLY.includes(event));

if (missingCovered.length > 0) {
  throw new Error(`the recording is missing ${missingCovered.join(', ')} — a re-recording must not lose a case`);
}

// Verify identifiers were removed before publishing the fixture.
const written = JSON.stringify(recorded);
const real = [os.homedir(), os.homedir().split('\\').join('/'), work, temp, log].filter(Boolean);

for (const value of real) {
  if (written.includes(value)) {
    throw new Error(`the recording still contains ${value}`);
  }
}

fs.writeFileSync(OUT, `${JSON.stringify(recorded, null, 2)}\n`);
fs.rmSync(temp, { recursive: true, force: true });

console.log(`hook-payloads.json ${recorded.length} payloads, events: ${[...seen].sort().join(', ')}`);

if (held.length > 0) {
  console.log(`carried forward from the previous recording: ${[...new Set(held.map((p) => p.hook_event_name))].join(', ')}`);
}

if (missing.length > 0) {
  console.log(`not captured and not on disk (needs --interactive): ${missing.join(', ')}`);
}
