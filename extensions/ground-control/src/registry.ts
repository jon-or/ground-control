import { makeClaudeAdapter } from '@ground-control/agent-claude';
import { makeVscodeHost } from '@ground-control/host-vscode';
import type { AgentAdapter } from '@ground-control/core';

/** Every agent CLI the board knows how to read. Adding one is a new entry here and nothing else. */
export const agents: readonly AgentAdapter[] = [makeClaudeAdapter()];

/** The application this client is resident in, which is the one host it can perform a route for. */
export const host = makeVscodeHost();
