import { afterEach } from 'vitest';

// The worker reads Vitest's replies only when its event loop turns, and birpc fails a call unanswered for 60 seconds.
// Tests that settle on microtasks alone never turn it, so a long file would fail with `Timeout calling "onTaskUpdate"`.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
