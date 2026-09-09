#!/usr/bin/env node
// Experimental subagent recovery. Reconstructs orphaned subagents from disk and emits the
// resume prompt for `claude --bg --resume <sid> "$(bump)"`. See docs/mechanics.md M14.
//
// Usage: node bump.mjs <project-slug-dir> <session-id> [--json]
//
// Known prototype defects; see docs/mechanics.md, Subagent recovery (M14):
//   1. Notification status is keyed on <task-id> (the agentId), NOT <tool-use-id>. This parser looks
//      for the latter and finds none, so completed agents still report as orphaned.
//   2. `death` reports the last error anywhere in the transcript, not the terminal one, and does not
//      sanitize multi-line tool output.
//   3. No guard against running while the parent is state:working.
// Reconstruction (prompt + type + progress) is correct; classification is not.

import fs from 'node:fs';
import path from 'node:path';

const [projectDir, sessionId, ...flags] = process.argv.slice(2);
if (!projectDir || !sessionId) {
  console.error('usage: bump.mjs <project-dir> <session-id> [--json]');
  process.exit(2);
}

const parentPath = path.join(projectDir, `${sessionId}.jsonl`);
const subagentsDir = path.join(projectDir, sessionId, 'subagents');

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

const parent = readLines(parentPath);

// 1. Every Agent dispatch, with its verbatim input.
const dispatches = new Map();
for (const record of parent) {
  const content = record.message?.content;
  if (!Array.isArray(content)) continue;
  for (const block of content) {
    if (block.type === 'tool_use' && block.name === 'Agent') {
      dispatches.set(block.id, {
        subagent_type: block.input?.subagent_type ?? 'general-purpose',
        description: block.input?.description ?? '(no description)',
        prompt: block.input?.prompt ?? '',
      });
    }
  }
}

// 2. Exclude launch acknowledgments, which share the result tool-use ID but do not indicate completion.
const delivered = new Set();
for (const record of parent) {
  const content = record.message?.content;
  if (!Array.isArray(content)) continue;
  for (const block of content) {
    if (block.type !== 'tool_result' || !dispatches.has(block.tool_use_id)) continue;
    if (JSON.stringify(block.content ?? '').includes('Async agent launched')) continue;
    delivered.add(block.tool_use_id);
  }
}

// 3. Terminal task notifications, keyed by the tool-use id they name.
const notified = new Map();
for (const record of parent) {
  const raw = JSON.stringify(record);
  if (!raw.includes('task-notification')) continue;
  const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(raw)?.[1];
  const status = /<status>([^<]+)<\/status>/.exec(raw)?.[1];
  if (toolUseId && status) notified.set(toolUseId, status);
}

// 4. Link subagent metadata to dispatches and read transcript progress and errors.
const orphans = [];
const metadataFiles = fs.existsSync(subagentsDir) ? fs.readdirSync(subagentsDir).filter((f) => f.endsWith('.meta.json')) : [];
for (const metadataFile of metadataFiles) {
  const meta = JSON.parse(fs.readFileSync(path.join(subagentsDir, metadataFile), 'utf8'));
  const agentId = metadataFile.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
  const toolUseId = meta.toolUseId;

  if (meta.spawnDepth !== 1) continue;              // nested agents resume with their parent
  if (delivered.has(toolUseId)) continue;
  if (notified.get(toolUseId) === 'completed') continue;

  const transcript = readLines(path.join(subagentsDir, metadataFile.replace('.meta.json', '.jsonl')));
  const actions = [];
  let lastError = null;
  for (const record of transcript) {
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use') actions.push(`${block.name}: ${(block.input?.description || block.input?.command || '').toString().slice(0, 70)}`);
      if (block.type === 'tool_result' && block.is_error) lastError = String(block.content).slice(0, 80);
    }
  }

  orphans.push({
    agentId,
    toolUseId,
    notified: notified.get(toolUseId) ?? null,
    ...(dispatches.get(toolUseId) ?? { subagent_type: meta.agentType, description: meta.description, prompt: '(prompt not recoverable)' }),
    progress: actions.slice(-4),
    death: lastError,
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

// Resume existing agents with SendMessage to preserve context and avoid duplicate work.
const lines = [
  'Generated subagent recovery instructions.',
  '',
  `${orphans.length} subagent(s) have no completion record. Call ListAgents before resuming them.`,
  '',
  '- Listed → continue it with SendMessage using its id below. Do not create a duplicate agent.',
  '- Not listed → start an Agent with the original prompt below.',
  '',
  'Do not ask whether to proceed. Handle all of them in one message, then continue your own work.',
  '',
];
orphans.forEach((record, i) => {
  lines.push(`### ${i + 1}. ${record.description}`);
  lines.push(`agentId: ${record.agentId}   (SendMessage to: '${record.agentId}')`);
  lines.push(`subagent_type: ${record.subagent_type}   (only if it must be re-created)`);
  lines.push('Original prompt:');
  lines.push('```');
  lines.push(record.prompt);
  lines.push('```');
  if (record.progress.length) {
    lines.push(`Recent actions: ${record.progress.join(' → ')}`);
  }
  if (record.death) lines.push(`Last error: ${record.death}`);
  lines.push('Skip any step already completed with a side effect; redo read-only steps.');
  lines.push('');
});
console.log(lines.join('\n'));
