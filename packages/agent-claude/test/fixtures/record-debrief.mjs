// Record one session's transcript skeleton for the debrief range reader: the main transcript and two subagent
// transcripts, one that called agent-delegate and one that did not. Run: node test/fixtures/record-debrief.mjs <main.jsonl>
// With --output <stdout.json>, scrub a saved debrief fork's stdout into debrief-output.json instead; record a fork
// that answered with no friction, since a friction answer quotes the session.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const PATHS = /[A-Za-z]:\\|\/Users\/|\/home\//;

if (process.argv[2] === '--output') {
  const events = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const FORK = '11111111-2222-4333-8444-555555555555';
  const USAGE = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
  // Keep each event's type; only the result event carries what the reader uses, and only its named fields are kept.
  const scrubbed = events.map((event) => {
    if (event.type !== 'result') return { type: event.type, ...(event.subtype ? { subtype: event.subtype } : {}), session_id: FORK };
    if (JSON.stringify(JSON.parse(event.result)) !== '{"friction":[]}') throw new Error('Record a debrief that answered {"friction":[]}.');
    const usage = Object.fromEntries(USAGE.filter((key) => key in event.usage).map((key) => [key, event.usage[key]]));
    return { type: 'result', subtype: event.subtype, is_error: event.is_error, num_turns: event.num_turns, result: event.result, total_cost_usd: event.total_cost_usd, usage, session_id: FORK };
  });
  const out = JSON.stringify(scrubbed, null, 1);
  if (PATHS.test(out)) throw new Error('The output still names a path.');
  writeFileSync(new URL('./debrief-output.json', import.meta.url), `${out}\n`);
  process.exit(0);
}

const source = process.argv[2];
if (!source) throw new Error('Pass the path of a main transcript whose subagents called agent-delegate.');

const sessionId = basename(source, '.jsonl');
const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';
const ids = new Map();
/** Delegated session IDs become stable synthetic ones, so the relation between calls survives. */
const synthetic = (id) => {
  if (!ids.has(id)) ids.set(id, `0190a000-0000-7000-8000-${String(ids.size + 1).padStart(12, '0')}`);
  return ids.get(id);
};
const skills = new Map();
/** Skill names are the developer's own; keep only which calls name the same skill. */
const skillName = (name) => {
  if (!skills.has(name)) skills.set(name, `skill-${String.fromCharCode(97 + skills.size)}`);
  return skills.get(name);
};
const DELEGATE = /^mcp__agent-delegate__/;
/** agent-delegate result fields whose values are its own vocabulary, not the developer's text. */
const DELEGATE_WORDS = new Set(['status', 'provider', 'transport']);

/** Keep an agent-delegate result's structure: IDs become synthetic, its own words stay, and other text is redacted. */
function delegateResult(value, key = null) {
  if (key === 'session_id' && typeof value === 'string') return synthetic(value);
  if (typeof value === 'string') return key !== null && DELEGATE_WORDS.has(key) ? value : '[redacted]';
  if (Array.isArray(value)) return value.map((item) => delegateResult(item));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, delegateResult(child, name)]));
  return value;
}

function delegateText(text) {
  try {
    return JSON.stringify(delegateResult(JSON.parse(text)));
  } catch {
    return '[redacted]';
  }
}

let prompts = 0;
/** A user message's text becomes a numbered placeholder; a harness notice keeps only its opening tag. */
const placeholder = (text) => {
  const tag = /^\s*<([A-Za-z-]+)[\s>]/.exec(text)?.[1];
  return tag ? `<${tag}>[redacted]</${tag}>` : `Recorded prompt ${++prompts}`;
};

/** Keep record identity, time, and the blocks the reader uses; every free-text value is replaced or dropped. */
function skeleton(text) {
  const calls = new Set();
  return text.split('\n').flatMap((line) => {
    let record;
    try { record = JSON.parse(line); } catch { return []; }
    if (record.type !== 'user' && record.type !== 'assistant') return [];
    const raw = record.message?.content;
    const content = Array.isArray(raw) ? raw : [];
    const blocks = typeof raw === 'string' ? (record.type === 'user' ? placeholder(raw) : '[redacted]') : content.map((block) => {
      if (block.type === 'tool_use') {
        if (DELEGATE.test(block.name)) calls.add(block.id);
        const input = block.name === 'Skill' && typeof block.input?.skill === 'string' ? { skill: skillName(block.input.skill) } : {};
        return { type: 'tool_use', id: block.id, name: block.name, input };
      }
      if (block.type === 'tool_result') {
        const items = typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : (block.content ?? []);
        const kept = items.map((item) => ({ type: item.type, text: calls.has(block.tool_use_id) && typeof item.text === 'string' ? delegateText(item.text) : '[redacted]' }));
        return { type: 'tool_result', tool_use_id: block.tool_use_id, content: kept };
      }
      if (block.type === 'text' && record.type === 'user') return { type: 'text', text: placeholder(block.text ?? '') };
      return { type: block.type };
    });
    return [{
      type: record.type, uuid: record.uuid, sessionId: record.sessionId === sessionId ? SESSION : record.sessionId,
      isSidechain: record.isSidechain, ...(record.isMeta ? { isMeta: true } : {}), timestamp: record.timestamp, message: { content: blocks },
    }];
  });
}

const dir = join(dirname(source), sessionId, 'subagents');
const agents = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
const texts = agents.map((name) => readFileSync(join(dir, name), 'utf8'));
const delegating = texts.find((text) => text.includes('"name":"mcp__agent-delegate__'));
const plain = texts.find((text) => !text.includes('"name":"mcp__agent-delegate__'));
if (!delegating || !plain) throw new Error('The session needs one subagent that called agent-delegate and one that did not.');

const recorded = { main: skeleton(readFileSync(source, 'utf8')), subagents: [skeleton(delegating), skeleton(plain)] };
const out = JSON.stringify(recorded);
if (out.includes(sessionId) || PATHS.test(out)) throw new Error('The skeleton still names the session or a path.');
writeFileSync(new URL('./debrief-transcript.json', import.meta.url), `${out}\n`);
