// Anonymize every capture through record.js. Allowlist payload fields so new undocumented fields require review
// before publication.
const { HOME, assertNoAbsolutePaths } = require('../../../../tools/fixture-scrub.js');

const SESSION = '00000000-0000-4000-8000-000000000000';
const TURN = '00000000-0000-4000-8000-000000000001';
const TOOL_USE = 'exec-00000000-0000-4000-8000-000000000002';
const CWD = `${HOME}/recorded`;
const TRANSCRIPT = `${HOME}/recorded/rollout-recorded.jsonl`;

/** Allowed recorded events, measured in mechanics M40. */
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'SessionEnd'];

/**
 * Preserve CLI facts under test: event, model, tool, source, reason, and flags. Replace user and machine
 * values.
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

    // Reject unknown fields until their scrubbing rules are reviewed.
    if (!replace) {
      throw new Error(`the recording carries an unknown field "${key}"; decide in anonymise.js whether it is kept or replaced`);
    }

    scrubbed[key] = replace(value);
  }

  return scrubbed;
}

/** Collect original user and machine identifiers for scrub checks. */
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

/** Require all measured events and reject original identifiers or identifying path formats (docs/testing.md). */
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
