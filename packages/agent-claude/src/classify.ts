import { z } from 'zod';
import type { ClassifyInput, ClassifyResult, ExecJson, ReadFailure } from '@ground-control/core';
import { CLAUDE_AGENT_ID } from './ids.js';

/**
 * Classification flags suppress transcripts/session-env, all settings, tools, and MCP servers, and assign a
 * known session ID (mechanics M31). Empty setting-sources also prevents ancestor settings from installing
 * hooks. Assert the complete argument list: classification can succeed even when an omitted flag leaks it into
 * history or activity.
 */
export function classifyArgs(input: ClassifyInput): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(input.schema),
    '--no-session-persistence',
    // `--setting-sources` and `--tools` are variadic, so each is written immediately before a flag. A bare value
    // after either would be swallowed as a second element rather than read as the next option.
    '--setting-sources',
    '',
    '--tools',
    '',
    '--strict-mcp-config',
    '--session-id',
    input.sessionId,
    '--system-prompt',
    input.systemPrompt,
    ...(input.model === null ? [] : ['--model', input.model]),
  ];
}

/** The fields of `--output-format json` this reads. Everything else the CLI prints is its own business. */
const printResult = z.object({
  is_error: z.boolean().optional(),
  subtype: z.string().optional(),
  structured_output: z.unknown().optional(),
  result: z.string().optional(),
});

function failure(kind: string, message: string, remedy: string): ReadFailure {
  return { subject: CLAUDE_AGENT_ID, kind, message, remedy };
}

/**
 * One bounded question, answered as JSON. Never throws and never leaves a session on the board: every failure comes
 * back named, the way a roster read's does, so a card that could not be triaged says so rather than showing a guess.
 */
export function makeClaudeClassifier(run: ExecJson) {
  return async function classify(input: ClassifyInput): Promise<ClassifyResult> {
    const outcome = await run(input.path, classifyArgs(input), {
      timeoutMs: input.timeoutMs,
      cwd: input.cwd,
      // Argv is capped at 32,767 characters on Windows and a card's conversation is not (`docs/mechanics.md` M31).
      stdin: input.prompt,
      signal: input.signal,
    });

    if (!outcome.ok) {
      const remedy =
        outcome.reason === 'missing' || outcome.reason === 'not-executable'
          ? 'Check groundControl.agents, or turn triage off in Settings.'
          : 'The card is left untriaged. Refresh the board to try it again.';

      return { failure: failure(`classify-${outcome.reason}`, `Claude Code could not classify this card: ${outcome.detail}`, remedy) };
    }

    const parsed = printResult.safeParse(outcome.value);

    if (!parsed.success) {
      return { failure: failure('classify-unreadable', 'Claude Code answered in a shape the board does not read.', 'Refresh the board to try again.') };
    }

    // The CLI reports its own trouble in the body rather than in an exit code — a usage limit reached mid-answer is a
    // successful process and an unsuccessful classification.
    if (parsed.data.is_error === true || (parsed.data.subtype !== undefined && parsed.data.subtype !== 'success')) {
      return {
        failure: failure(
          'classify-refused',
          `Claude Code did not finish classifying this card${parsed.data.subtype ? ` (${parsed.data.subtype})` : ''}.`,
          'Check groundControl.triage.model names a model Claude Code has. The card is left unread; its chip tries again.',
        ),
      };
    }

    if (parsed.data.structured_output !== undefined) {
      return { value: parsed.data.structured_output };
    }

    // `result` carries the same JSON as a string. Read only where the parsed field is absent, which is what an older
    // CLI that predates structured output answers with.
    try {
      return { value: JSON.parse(parsed.data.result ?? '') };
    } catch {
      return { failure: failure('classify-unparsable', 'Claude Code answered with no structured result.', 'Refresh the board to try again.') };
    }
  };
}
