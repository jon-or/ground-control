import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL } from '@ground-control/core';
import type { StageAnswer } from '@ground-control/core';
import { fingerprintOf, sendStage } from '../src/discover.js';
import { proofOf } from '../src/server.js';
import { hubJsonPathOf } from '../src/paths.js';
import { STAGE_EXIT, STAGE_USAGE, parseStageArgs, stageOutcome } from '../src/stageCommand.js';
import { tempHome } from './helpers.js';

const TOKEN = 'the-token-nobody-else-gets';
const shut: (() => void)[] = [];

afterEach(() => {
  while (shut.length) shut.pop()?.();
});

/** A hub for `home` that proves its token and answers `/stage` with `answer`, or with `status` alone. */
function stageHub(home: string, answer: StageAnswer | null, status = 200): Promise<{ bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/hub') {
      const nonce = url.searchParams.get('nonce') ?? '';
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ hub: 'ground-control', protocol: PROTOCOL, fingerprint: fingerprintOf(home), proof: proofOf(TOKEN, nonce) }));
      return;
    }

    let body = '';
    incoming.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    incoming.on('end', () => {
      bodies.push(`${incoming.method} ${url.pathname} ${incoming.headers.authorization} ${body}`);
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(answer === null ? '{"error":"No such route."}' : JSON.stringify(answer));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      shut.push(() => { server.close(); server.closeAllConnections(); });
      mkdirSync(home, { recursive: true });
      writeFileSync(hubJsonPathOf(home), JSON.stringify({
        protocol: PROTOCOL, version: '0.0.0', port: (server.address() as { port: number }).port, token: TOKEN, pid: 1,
        startedAt: '2026-09-03T10:00:00.000Z', fingerprint: fingerprintOf(home),
      }));
      resolve({ bodies });
    });
  });
}

describe('the stage command a skill runs (R49)', () => {
  it('reads the issue, the stage, and a note in either form', () => {
    expect(parseStageArgs(['15619', 'build', '--note', 'commit 2/4 · Codex review'])).toEqual({ issue: 15619, stage: 'build', note: 'commit 2/4 · Codex review' });
    expect(parseStageArgs(['--note=ready for your review', '#15619', 'review'])).toEqual({ issue: 15619, stage: 'review', note: 'ready for your review' });
    expect(parseStageArgs(['15619', 'done'])).toEqual({ issue: 15619, stage: 'done', note: '' });
    expect(parseStageArgs(['15619', 'plan', '--step', '2/3', '--note=plan'])).toEqual({ issue: 15619, stage: 'plan', note: 'plan', step: { n: 2, of: 3 } });
    expect(parseStageArgs(['15619', 'build', '--step=9/9'])).toEqual({ issue: 15619, stage: 'build', note: '', step: { n: 9, of: 9 } });
  });

  it('prints usage for anything else', () => {
    expect(parseStageArgs(['15619'])).toEqual({ usage: STAGE_USAGE });
    expect(parseStageArgs(['15619', 'ship'])).toEqual({ usage: STAGE_USAGE });
    expect(parseStageArgs(['x', 'plan'])).toEqual({ usage: STAGE_USAGE });
    expect(parseStageArgs(['15619', 'plan', 'extra'])).toEqual({ usage: STAGE_USAGE });
    expect(parseStageArgs(['15619', 'plan', '--note'])).toEqual({ usage: `--note needs a value. ${STAGE_USAGE}` });
    expect(parseStageArgs(['15619', 'plan', '--force'])).toEqual({ usage: `Unknown option --force. ${STAGE_USAGE}` });
    for (const step of ['4/3', '0/3', '1/51', '2', 'two/three']) {
      expect(parseStageArgs(['15619', 'plan', '--step', step])).toEqual({ usage: `--step takes <n>/<of>. ${STAGE_USAGE}` });
    }
    expect(parseStageArgs(['15619', 'plan', '--step'])).toEqual({ usage: `--step needs a value. ${STAGE_USAGE}` });
  });

  it('exits 0, 2, or 3 so a skill can tell a record from a missing hub and a refusal', () => {
    const request = { issue: 15619, stage: 'build' as const, note: '' };

    expect(stageOutcome(request, { answer: { ok: true, lane: 'build', note: 'round 2', pending: false } }))
      .toEqual({ code: STAGE_EXIT.recorded, line: 'Issue 15619 is in build · round 2.' });
    expect(stageOutcome(request, { answer: { ok: true, lane: null, note: '', pending: true } }))
      .toEqual({ code: 0, line: 'Issue 15619 is not on the board yet; it goes to build once it appears.' });
    expect(stageOutcome(request, { unreached: 'no Ground Control hub is running for this home' }))
      .toEqual({ code: 2, line: 'Stage not recorded: no Ground Control hub is running for this home.' });
    expect(stageOutcome(request, { answer: { ok: false, reason: 'No evidence ledger.' } }))
      .toEqual({ code: 3, line: 'Stage refused: No evidence ledger.' });
  });

  it('sends the report to the proven hub with its token, and relays its answer', async () => {
    const { home, dispose } = tempHome();
    shut.push(dispose);
    const hub = await stageHub(home, { ok: false, reason: 'No evidence ledger.' }, 409);

    expect(await sendStage(home, { issue: 15619, stage: 'review', note: 'x' })).toEqual({ answer: { ok: false, reason: 'No evidence ledger.' } });
    expect(hub.bodies).toEqual([`POST /stage Bearer ${TOKEN} {"issue":15619,"stage":"review","note":"x"}`]);
  });

  it('reports a missing hub and one too old for stages as unreached', async () => {
    const { home, dispose } = tempHome();
    shut.push(dispose);

    expect(await sendStage(home, { issue: 1, stage: 'plan', note: '' })).toEqual({ unreached: 'no Ground Control hub is running for this home' });

    await stageHub(home, null, 404);

    expect(await sendStage(home, { issue: 1, stage: 'plan', note: '' }))
      .toEqual({ unreached: 'the running hub predates stage reports; reload the editor window to update it' });
  });
});
