// This repo is public, so a recorded payload names no real session, checkout, home directory or prompt. Run
// by `record.js` over every capture: a hand-scrub is undone by the next one.
//
// Built from an allowlist rather than by overwriting known keys: a spread carries every field the scrubber has never
// heard of, and Codex's hook payload is not a documented contract, so the next version's new field would ship
// verbatim. Values out, shape in.
const { HOME, assertNoAbsolutePaths } = require('../../../../tools/fixture-scrub.js');

const SESSION = '00000000-0000-4000-8000-000000000000';
const TURN = '00000000-0000-4000-8000-000000000001';
const TOOL_USE = 'exec-00000000-0000-4000-8000-000000000002';
const CWD = `${HOME}/recorded`;
const TRANSCRIPT = `${HOME}/recorded/rollout-recorded.jsonl`;

/** The events one session fires, and the only set a fixture may carry. Measured in `docs/mechanics.md` §40. */
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'SessionEnd'];

/**
 * What each field becomes. A field whose value is a CLI fact the tests turn on — an event name, a model, a tool
 * name, a source, a reason, a flag — is kept; everything that came from the developer or their machine is replaced.
 */
const FIELDS = {
  session_id: () => SESSION,
  turn_id: () => TURN,
  transcript_path: () => TRANSCRIPT,
  cwd: () => CWD,
  hook_event_name: (value) => value,
  model: (value) => value,
  permission_mode: (value) => value,
  source: (value) => value,
  prompt: () => 'recorded',
  tool_name: (value) => value,
  tool_input: (value) => ('description' in value ? { command: 'recorded', description: 'recorded' } : { command: 'recorded' }),
  tool_use_id: () => TOOL_USE,
  tool_response: () => '',
  stop_hook_active: (value) => value,
  last_assistant_message: () => 'recorded',
  reason: (value) => value,
};

function anonymisePayload(payload) {
  const scrubbed = {};

  for (const [key, value] of Object.entries(payload)) {
    const replace = FIELDS[key];

    // A field nobody has decided about is a leak waiting for the next Codex version, so it stops the recording.
    if (!replace) {
      throw new Error(`the recording carries an unknown field "${key}"; decide in anonymise.js whether it is kept or replaced`);
    }

    scrubbed[key] = replace(value);
  }

  return scrubbed;
}

/** Every value a recording could carry that names the developer or their machine, gathered from the input. */
function identifying(payloads) {
  const values = new Set();

  for (const payload of payloads) {
    for (const key of ['session_id', 'turn_id', 'transcript_path', 'cwd', 'prompt', 'tool_use_id', 'last_assistant_message']) {
      const value = payload[key];

      if (typeof value === 'string' && value.trim()) {
        values.add(value);
      }
    }

    const command = payload.tool_input?.command;
    const description = payload.tool_input?.description;

    for (const free of [command, description]) {
      if (typeof free === 'string' && free.trim()) {
        values.add(free);
      }
    }
  }

  return [...values];
}

/**
 * Asserts twice, as `docs/testing.md` asks: every value the scrub set out to replace is gone, and nothing of the
 * shape it scrubs survives at all. A recording missing an event fails here too — a re-record that cannot provoke
 * one must fail rather than quietly shrink the fixture.
 */
function anonymise(payloads) {
  const scrubbed = payloads.map(anonymisePayload);
  const written = JSON.stringify(scrubbed);

  for (const value of identifying(payloads)) {
    if (written.includes(value)) {
      throw new Error(`anonymise left a recorded value: ${value.slice(0, 60)}`);
    }
  }

  assertNoAbsolutePaths(written, [HOME.toLowerCase()]);

  const events = scrubbed.map((payload) => payload.hook_event_name);

  for (const event of EVENTS) {
    if (!events.includes(event)) {
      throw new Error(`the recording is missing ${event}; see README.md for how to provoke it`);
    }
  }

  return scrubbed;
}

module.exports = { anonymise, EVENTS, SESSION, TURN, TOOL_USE, CWD, TRANSCRIPT };
