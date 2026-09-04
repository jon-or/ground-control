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

/** A hub's answers are a few hundred bytes. Anything that keeps writing is something else, and is not read to the end. */
const ANSWER_LIMIT_BYTES = 256 * 1024;

interface Answer {
  status: number;
  body: string;
}

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
): Promise<Answer | null> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}` };

    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
      headers['Content-Type'] = 'application/json';
    }

    let settled = false;

    const outbound = request({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;

        if (body.length > ANSWER_LIMIT_BYTES) {
          done(null);
        }
      });
      response.on('end', () => done({ status: response.statusCode ?? 0, body }));
    });

    function done(answer: Answer | null): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(deadline);
      outbound.destroy();
      resolve(answer);
    }

    const deadline = setTimeout(() => done(null), timeoutMs);

    outbound.on('error', () => done(null));
    outbound.end(token === null ? undefined : '{}');
  });
}

/** Asks whatever holds the port what it is. Anything but a hub answering as one is `null`, including a hung socket. */
export async function probeHub(port: number, timeoutMs = PROBE_TIMEOUT_MS, nonce?: string): Promise<HubIdentity | null> {
  const answer = await call(port, 'GET', nonce ? `/hub?nonce=${nonce}` : '/hub', null, timeoutMs);

  if (answer === null || answer.status !== 200) {
    return null;
  }

  try {
    const parsed = hubIdentity.safeParse(JSON.parse(answer.body));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
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
  const record = readHubRecord(home);

  if (record === null) {
    return null;
  }

  const nonce = randomBytes(16).toString('base64url');
  const identity = await probeHub(record.port, timeoutMs, nonce);

  // The fingerprint says which home; the proof says it is the hub that minted this record. A home path is guessable,
  // so without the proof any local process could stand up a listener, be handed the token, and be believed.
  if (identity === null || identity.fingerprint !== fingerprintOf(home) || !proves(identity, record, nonce)) {
    return null;
  }

  return { record, identity };
}

/** The hub this home already has and this client can talk to. A different protocol is a hub, but not one of ours. */
export async function liveHub(home: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<LiveHub | null> {
  const found = await recordedHub(home, timeoutMs);

  return found && protocolMatches(found.identity) ? found : null;
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

  if (held === null) {
    return false;
  }

  const answer = await call(held.record.port, 'POST', '/shutdown', held.record.token, timeoutMs);

  return answer?.status === 200;
}

/** Whether a client speaking this protocol can talk to that hub. Equal, because the number moves only on a break. */
function protocolMatches(identity: HubIdentity): boolean {
  return identity.protocol === PROTOCOL;
}
