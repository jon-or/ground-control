// Records real Claude Code hook payloads: `node test/fixtures/record-hooks.js [--interactive]`.
// Hooks are supplied through `claude --settings <file>`, so the developer's own ~/.claude/settings.json is never
// touched. Read the diff before committing — a fixture is evidence.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HOME } = require('./anonymise.js');

const here = __dirname;
const OUT = path.join(here, 'hook-payloads.json');

/**
 * Every event the board installs, plus `PostToolUse` and `SessionStart` — recorded so a test can prove the writer
 * transcribes an event the board maps to nothing rather than refusing it.
 */
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

/** What a `-p` run cannot produce: there is no prompt for a human to answer, so no human gate is ever reached. */
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

// One turn that reads a file, runs two commands in one batch, and spawns a subagent — which is what makes
// PostToolBatch fire more than once and SubagentStop fire at all.
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

/** Keys whose values name real work — a prompt, a command, a checkout — and cannot be anonymised by rewriting. */
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
 * Values out, shape in. Every field the writer reads keeps its recorded value; every field that names real work is
 * replaced, and a `background_tasks` entry becomes an empty object because only its count is ever read.
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

// Carried forward, not replaced: the interactive payloads cannot be produced by this script, so a routine
// re-recording without `--interactive` would otherwise drop them and the tests would lose those cases silently.
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

// The scrub is asserted, not trusted: this repo is public and a recording named real checkouts a moment ago.
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
