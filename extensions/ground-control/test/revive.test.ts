import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LANE_ORDER, LANE_TITLES } from '@ground-control/board';
import type { Lane } from '@ground-control/board';

/**
 * The board a panel comes back to after a reload, which is the one payload the webview reads that it did not just
 * receive. A panel revived after an extension update holds the payload the previous version stored, so the shape is
 * whatever that version wrote — the reason this is its own file is that the script reads the state once, at import.
 */

/** A card carrying one session, with whatever session shape the test is reviving. */
function payloadWith(session: Record<string, unknown>): Record<string, unknown> {
  const card = {
    key: 'issue:18953',
    issueNumber: 18953,
    lane: 'unstarted',
    returned: false,
    attention: null,
    reason: '⚒️ Dev',
    issue: null,
    sessions: [session],
  };

  return {
    type: 'board',
    lanes: LANE_ORDER.map((id) => ({
      id,
      title: LANE_TITLES[id],
      cards: id === 'unstarted' ? [card] : [],
    })) as unknown as Lane[],
    openable: [session['sessionId']],
    issues: null,
    sessions: null,
    hooks: null,
    failures: [],
  };
}

const CURRENT = {
  agent: 'claude',
  sessionId: 'session-1',
  pid: 4242,
  title: null,
  cwd: 'c:/work/18953-cache-remediation',
  startedAt: 1,
  branch: '18953-cache-remediation',
  issueNumber: 18953,
  transcriptWrittenAt: null,
  activity: null,
  finished: false,
  details: { kind: 'interactive', name: 'cache-remediation' },
};

/** What a version before the neutral session stored: the agent's words at the top level, and no bag at all. */
const { details, ...rest } = CURRENT;
const LEGACY = { ...rest, kind: 'interactive', name: 'cache-remediation', state: 'editing tests', status: 'working' };

async function revive(state: unknown): Promise<void> {
  vi.resetModules();
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), setState: vi.fn(), getState: () => state }));
  vi.stubGlobal('setInterval', () => 0);

  document.head.innerHTML = `<style>${readFileSync(resolve('media/board.css'), 'utf8')}</style>`;
  document.body.innerHTML = `
    <header>
      <div id="meta"></div>
      <label id="archived-toggle" hidden><input id="show-archived" type="checkbox"> Show archived (<span id="archived-count">0</span>)</label>
      <button id="refresh" type="button">Refresh</button>
    </header>
    <div id="notices"></div><main id="lanes"></main>
  `;

  // Through a variable, as `board.test.ts` does: a literal path to a plain JS file has no declaration to find.
  const boardScript = '../media/board.js';

  await import(boardScript);
}

describe('reviving a stored board', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('draws the cards it stored itself', async () => {
    await revive({ payload: payloadWith(CURRENT), showArchived: false });

    expect(document.querySelectorAll('.card')).toHaveLength(1);
    expect(document.querySelector('.session')?.textContent).toContain('cache-remediation');
  });

  it('draws nothing from a board stored by a version whose sessions predate the details bag', async () => {
    await revive({ payload: payloadWith(LEGACY), showArchived: false });

    // Not a caught exception: the render must never be attempted, because a half-drawn lane is what the developer
    // would be left looking at until the first live message arrives.
    expect(document.querySelectorAll('.card')).toHaveLength(0);
    expect(document.getElementById('lanes')?.children).toHaveLength(0);
  });
});
