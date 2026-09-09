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
    // Place each variadic option before another flag so subsequent values cannot be parsed as extra option
    // arguments.
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

/** Fields read from --output-format json. */
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
 * Classify within a timeout and return structured failures. Disable persistence and hooks so the
 * unprompted-session filter excludes classification from the board.
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
      return { failure: failure('classify-unreadable', 'Claude Code returned an unsupported response format.', 'Refresh the board to try again.') };
    }

    // Check body-level errors even after exit 0; usage limits can fail a classification without failing the
    // process.
    if (parsed.data.is_error === true || (parsed.data.subtype !== undefined && parsed.data.subtype !== 'success')) {
      return {
        failure: failure(
          'classify-refused',
          `Claude Code did not finish classifying this card${parsed.data.subtype ? ` (${parsed.data.subtype})` : ''}.`,
          'Check Claude Code usage limits and groundControl.triage.model, then retry triage from the card in VS Code.',
        ),
      };
    }

    if (parsed.data.structured_output !== undefined) {
      return { value: parsed.data.structured_output };
    }

    // Fall back to the JSON result string for older CLIs without structured_output.
    try {
      return { value: JSON.parse(parsed.data.result ?? '') };
    } catch {
      return { failure: failure('classify-unparsable', 'Claude Code answered with no structured result.', 'Refresh the board to try again.') };
    }
  };
}
