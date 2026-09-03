import { makeClaudeAdapter } from '@ground-control/agent-claude';
import type { AgentAdapter } from '@ground-control/core';

/** Every agent CLI the board knows how to read. Adding one is a new entry here and nothing else. */
export const agents: readonly AgentAdapter[] = [makeClaudeAdapter()];
