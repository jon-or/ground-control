#!/usr/bin/env node
// bump.mjs — prototype of `factory bump`. Reconstructs orphaned subagents from disk and emits the
// resume prompt for `claude --bg --resume <sid> "$(bump)"`. See docs/mechanics.md §14.
//
// Usage: node bump.mjs <project-slug-dir> <session-id> [--json]
//
// PROTOTYPE — known broken, see mechanics §14 "Classifier details the prototype got wrong":
//   1. Notification status is keyed on <task-id> (the agentId), NOT <tool-use-id>. This parser looks
//      for the latter and finds none, so completed agents still report as orphaned.
//   2. `death` takes the last error anywhere in the transcript, not the terminal one, and does not
//      sanitize multi-line tool output.
//   3. No guard against running while the parent is state:working.
// Reconstruction (prompt + type + progress) is correct; classification is not.

import fs from 'node:fs';
import path from 'node:path';

const [projDir, sessionId, ...flags] = process.argv.slice(2);
if (!projDir || !sessionId) {
  console.error('usage: bump.mjs <project-dir> <session-id> [--json]');
  process.exit(2);
}

const parentPath = path.join(projDir, `${sessionId}.jsonl`);
const subDir = path.join(projDir, sessionId, 'subagents');

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

const parent = readLines(parentPath);

// 1. Every Agent dispatch, with its verbatim input.
const dispatches = new Map();
for (const o of parent) {
  const c = o.message?.content;
  if (!Array.isArray(c)) continue;
  for (const b of c) {
    if (b.type === 'tool_use' && b.name === 'Agent') {
      dispatches.set(b.id, {
        subagent_type: b.input?.subagent_type ?? 'general-purpose',
        description: b.input?.description ?? '(no description)',
        prompt: b.input?.prompt ?? '',
      });
    }
  }
}

// 2. Delivered results. The launch acknowledgement is ALSO a tool_result on the same id — excluding
// it is what keeps every async agent from classifying as delivered.
const delivered = new Set();
for (const o of parent) {
  const c = o.message?.content;
  if (!Array.isArray(c)) continue;
  for (const b of c) {
    if (b.type !== 'tool_result' || !dispatches.has(b.tool_use_id)) continue;
    if (JSON.stringify(b.content ?? '').includes('Async agent launched')) continue;
    delivered.add(b.tool_use_id);
  }
}

// 3. Terminal task notifications, keyed by the tool-use id they name.
const notified = new Map();
for (const o of parent) {
  const raw = JSON.stringify(o);
  if (!raw.includes('task-notification')) continue;
  const tu = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(raw)?.[1];
  const status = /<status>([^<]+)<\/status>/.exec(raw)?.[1];
  if (tu && status) notified.set(tu, status);
}

// 4. Subagent metas link an agent id to its dispatch, and its own transcript says how it died.
const orphans = [];
const metas = fs.existsSync(subDir) ? fs.readdirSync(subDir).filter((f) => f.endsWith('.meta.json')) : [];
for (const m of metas) {
  const meta = JSON.parse(fs.readFileSync(path.join(subDir, m), 'utf8'));
  const agentId = m.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
  const tu = meta.toolUseId;

  if (meta.spawnDepth !== 1) continue;              // nested agents come back with their own parent
  if (delivered.has(tu)) continue;
  if (notified.get(tu) === 'completed') continue;

  const tx = readLines(path.join(subDir, m.replace('.meta.json', '.jsonl')));
  const actions = [];
  let death = null;
  for (const o of tx) {
    const c = o.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === 'tool_use') actions.push(`${b.name}: ${(b.input?.description || b.input?.command || '').toString().slice(0, 70)}`);
      if (b.type === 'tool_result' && b.is_error) death = String(b.content).slice(0, 80);
    }
  }

  orphans.push({
    agentId,
    toolUseId: tu,
    notified: notified.get(tu) ?? null,
    ...(dispatches.get(tu) ?? { subagent_type: meta.agentType, description: meta.description, prompt: '(prompt not recoverable)' }),
    progress: actions.slice(-4),
    death,
  });
}

if (flags.includes('--json')) {
  console.log(JSON.stringify({ sessionId, orphans }, null, 2));
  process.exit(0);
}

if (orphans.length === 0) {
  console.log('Continue where you left off. No orphaned subagents were found.');
  process.exit(0);
}

// Continue the EXISTING agents, never start fresh ones. A new Agent call loses their context and
// duplicates work the runtime may already have resumed; SendMessage picks the same agent back up.
const lines = [
  'Resume brief (generated — not written by you).',
  '',
  `${orphans.length} subagent(s) have no completion record. For EACH one, call ListAgents first.`,
  '',
  '- Listed → continue it with SendMessage using its id below. Do NOT start a new Agent for it.',
  '- Not listed → only then dispatch a fresh Agent with the verbatim prompt below.',
  '',
  'Do not ask whether to proceed. Handle all of them in one message, then continue your own work.',
  '',
];
orphans.forEach((o, i) => {
  lines.push(`### ${i + 1}. ${o.description}`);
  lines.push(`agentId: ${o.agentId}   (SendMessage to: '${o.agentId}')`);
  lines.push(`subagent_type: ${o.subagent_type}   (only if it must be re-created)`);
  lines.push('Original prompt, verbatim:');
  lines.push('```');
  lines.push(o.prompt);
  lines.push('```');
  if (o.progress.length) {
    lines.push(`Prior attempt got as far as: ${o.progress.join(' → ')}`);
  }
  if (o.death) lines.push(`It died with: ${o.death}`);
  lines.push('Skip any step already completed with a side effect; redo read-only steps.');
  lines.push('');
});
console.log(lines.join('\n'));
