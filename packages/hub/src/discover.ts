import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { request } from 'node:http';
import { z } from 'zod';
import { PROTOCOL, groundControlDirOf } from '@ground-control/core';
import { read } from './fs.js';
import { hubJsonPathOf } from './paths.js';
import { proofOf } from './server.js';

/** What a running hub records so a client can reach it. Written after the bind, so a port here was live once. */
export interface HubRecord {
  protocol: number;
  version: string;
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  fingerprint: string;
}

const hubRecord = z.object({
  protocol: z.number().int(),
  version: z.string(),
  port: z.number().int().min(1).max(65_535),
  token: z.string().min(1),
  pid: z.number().int(),
  startedAt: z.string(),
  fingerprint: z.string().min(1),
});

/** What `GET /hub` answers. Enough to tell a hub from any other process that took the port, and nothing else. */
export interface HubIdentity {
  hub: string;
  protocol: number;
  fingerprint: string;
  /** Present when a nonce was asked for: the listener's proof that it holds the token, never the token itself. */
  proof?: string | undefined;
}

const hubIdentity = z.object({
  hub: z.literal('ground-control'),
  protocol: z.number().int(),
  fingerprint: z.string(),
  proof: z.string().optional(),
});

/**
 * Which hub this is: the configuration directory it runs against. Two developers on one machine, or one developer
 * running against a second home, get different hubs, and neither sends its token to the other's listener.
 */
export function fingerprintOf(home: string): string {
  return createHash('sha256').update(groundControlDirOf(home)).digest('hex').slice(0, 16);
}

/** Never throws: a hub mid-write, a hub killed, and no hub at all are all "nothing to connect to yet". */
export function readHubRecord(home: string): HubRecord | null {
  const text = read(hubJsonPathOf(home));

  if (text === null) {
    return null;
  }

  try {
    const parsed = hubRecord.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const PROBE_TIMEOUT_MS = 500;

/** What a probe that went quiet is given on the second ask, wide enough for a client that was busy rather than lost. */
const SECOND_LOOK_MS = 3000;

/** A hub's answers are a few hundred bytes. Anything that keeps writing is something else, and is not read to the end. */
const ANSWER_LIMIT_BYTES = 256 * 1024;

interface Answer {
  status: number;
  body: string;
}

/** Why a call did not come back. Kept apart because a port nothing holds and a port that went quiet are not one state. */
type Unanswered = 'unreachable' | 'silent';

/**
 * Null for anything that is not a whole answer inside the deadline. The deadline is absolute rather than the socket's
 * own inactivity timer: a listener that trickles bytes faster than that timer resets it forever, and this call is
 * what a hub makes before it binds, so a hang here is a hub that never starts and never says why.
 */
function call(
  port: number,
  method: string,
  path: string,
  token: string | null,
  timeoutMs: number,
): Promise<Answer | Unanswered> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}` };

    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
      headers['Content-Type'] = 'application/json';
    }

    let settled = false;

    // Never a pooled socket, the rule every request this package makes follows: the agent belongs to whatever
    // process the client runs in, and a hub probe must not queue behind whatever else that process is doing.
    const outbound = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;

        if (body.length > ANSWER_LIMIT_BYTES) {
          done('silent');
        }
      });
      response.on('end', () => done({ status: response.statusCode ?? 0, body }));
    });

    function done(answer: Answer | Unanswered): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(deadline);
      outbound.destroy();
      resolve(answer);
    }

    const deadline = setTimeout(() => done('silent'), timeoutMs);

    outbound.on('error', () => done('unreachable'));
    outbound.end(token === null ? undefined : '{}');
  });
}

/**
 * What a listener that is not this home's hub answered. Kept and shown, because the alternative is telling a
 * developer that a stranger holds the port on no evidence — and the answer is the only evidence there is: a hub
 * that turned this client away logs it, and anything else on that port keeps no record of having been asked.
 */
export interface Saw {
  status: number;
  said: string;
}

/** Enough of an answer to recognise what gave it. One line, because this goes in a notification. */
const SAID_LIMIT = 60;

function saw(answer: Answer): Saw {
  const said = answer.body.replace(/\s+/g, ' ').trim();

  return { status: answer.status, said: said.length > SAID_LIMIT ? `${said.slice(0, SAID_LIMIT)}\u2026` : said };
}

/** Asks whatever holds the port what it is: what it said it was, or how the asking came to nothing. */
type Probed = HubIdentity | Unanswered | { notAHub: Saw };

export async function probe(port: number, timeoutMs = PROBE_TIMEOUT_MS, nonce?: string): Promise<Probed> {
  const answer = await call(port, 'GET', nonce ? `/hub?nonce=${nonce}` : '/hub', null, timeoutMs);

  if (typeof answer === 'string') {
    return answer;
  }

  if (answer.status !== 200) {
    return { notAHub: saw(answer) };
  }

  try {
    const parsed = hubIdentity.safeParse(JSON.parse(answer.body));

    return parsed.success ? parsed.data : { notAHub: saw(answer) };
  } catch {
    return { notAHub: saw(answer) };
  }
}

export interface LiveHub {
  record: HubRecord;
  identity: HubIdentity;
}

/**
 * The hub this home's record names, proven to be this developer's whatever protocol it speaks. Liveness is the probe
 * and never the file: a hub killed on Windows gets no chance to remove `hub.json`, so a stale record is the normal
 * state rather than an error. A listener that is not a hub, or is a hub for another home, is not one to send a
 * token to.
 */
export async function recordedHub(home: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<LiveHub | null> {
  const found = await findHub(home, timeoutMs);

  if ('hub' in found) {
    return found.hub;
  }

  // A hub of another protocol is still this developer's hub, proven and running. It is the one a client may have to
  // stop, and the one a starting hub must stand down against, so only the protocol check treats it as absent.
  return found.miss.why === 'another-protocol' ? found.miss.hub : null;
}

/**
 * Why this home has no hub to talk to. Seven things come to the same nothing at a client, and a board that says the
 * wrong one of them sends the developer to a log that describes none of it — which is the whole of what there is to
 * go on, because the hub that was in the way keeps no record of having turned anyone away.
 */
export type HubMiss =
  | { why: 'no-record' }
  | { why: 'unreachable'; record: HubRecord }
  | { why: 'silent'; record: HubRecord }
  | { why: 'not-a-hub'; record: HubRecord; saw: Saw }
  | { why: 'another-home'; record: HubRecord }
  | { why: 'unproven'; record: HubRecord }
  | { why: 'another-protocol'; hub: LiveHub };

export type Found = { hub: LiveHub } | { miss: HubMiss };

/**
 * The hub this home's record names, proven to be this developer's, or the reason there is none. Liveness is the
 * probe and never the file: a hub killed on Windows gets no chance to remove `hub.json`, so a stale record is the
 * normal state rather than an error.
 */
export async function findHub(home: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<Found> {
  const record = readHubRecord(home);

  if (record === null) {
    return { miss: { why: 'no-record' } };
  }

  const nonce = randomBytes(16).toString('base64url');
  let identity = await probe(record.port, timeoutMs, nonce);

  // A hub that did not finish answering inside half a second is asked once more, with room: the deadline is spent
  // on the client's own event loop, and a window that has just woken up or just activated is not a hub that is gone.
  if (identity === 'silent') {
    identity = await probe(record.port, SECOND_LOOK_MS, nonce);
  }

  if (typeof identity === 'string') {
    return { miss: { why: identity, record } };
  }

  if ('notAHub' in identity) {
    return { miss: { why: 'not-a-hub', record, saw: identity.notAHub } };
  }

  // The fingerprint says which home; the proof says it is the hub that minted this record. A home path is guessable,
  // so without the proof any local process could stand up a listener, be handed the token, and be believed.
  if (identity.fingerprint !== fingerprintOf(home)) {
    return { miss: { why: 'another-home', record } };
  }

  if (!proves(identity, record, nonce)) {
    return { miss: { why: 'unproven', record } };
  }

  return protocolMatches(identity)
    ? { hub: { record, identity } }
    : { miss: { why: 'another-protocol', hub: { record, identity } } };
}

function proves(identity: HubIdentity, record: HubRecord, nonce: string): boolean {
  const offered = Buffer.from(identity.proof ?? '');
  const wanted = Buffer.from(proofOf(record.token, nonce));

  return offered.length === wanted.length && timingSafeEqual(offered, wanted);
}

/**
 * Stops the hub this home has, whatever protocol it speaks: stopping one is the same route in every version, and a
 * hub a client cannot talk to is exactly the one it may need to replace.
 */
export async function stopHub(home: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const held = await recordedHub(home, timeoutMs);

  return held !== null && stopThisHub(held, timeoutMs);
}

/**
 * Stops one particular hub. The record decides where the stop goes, never the file read again: between finding a hub
 * and standing it down, another client's replacement may already hold the record, and stopping that one would be a
 * client killing the hub it was about to connect to.
 */
export async function stopThisHub(hub: LiveHub, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const answer = await call(hub.record.port, 'POST', '/shutdown', hub.record.token, timeoutMs);

  return typeof answer !== 'string' && answer.status === 200;
}

/** Whether a client speaking this protocol can talk to that hub. Equal, because the number moves only on a break. */
function protocolMatches(identity: HubIdentity): boolean {
  return identity.protocol === PROTOCOL;
}
