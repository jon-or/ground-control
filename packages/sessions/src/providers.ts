import type { SessionProvider } from './provider.js';
import { makeClaudeProvider } from './providers/claude.js';

/** Every agent CLI the board knows how to read. Adding one is a new entry here and nothing else. */
const registry: SessionProvider[] = [makeClaudeProvider()];

export function providers(): readonly SessionProvider[] {
  return registry;
}
