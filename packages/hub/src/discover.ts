import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { request } from 'node:http';
import { z } from 'zod';
import { PROTOCOL, groundControlDirOf } from '@ground-control/core';
import { read } from './fs.js';
import { hubJsonPathOf } from './paths.js';
import { proofOf } from './server.js';

/** Connection record written after binding the hub port. */
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

/** GET /hub identity response. */
export interface HubIdentity {
  hub: string;
  protocol: number;
  fingerprint: string;
  /** Proof of token possession when requested with a nonce; excludes the token. */
  proof?: string | undefined;
}

const hubIdentity = z.object({
  hub: z.literal('ground-control'),
  protocol: z.number().int(),
  fingerprint: z.string(),
  proof: z.string().optional(),
});

/** Identify the configuration home so clients do not send tokens to another home's hub. */
export function fingerprintOf(home: string): string {
  return createHash('sha256').update(groundControlDirOf(home)).digest('hex').slice(0, 16);
}

/** Return null for missing, unreadable, or incomplete records. */
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

/** Longer timeout for retrying a silent probe after client startup or suspend. */
const SECOND_LOOK_MS = 3000;

/** Bound identity responses to reject oversized or continuously streamed data. */
const ANSWER_LIMIT_BYTES = 256 * 1024;

interface Answer {
  status: number;
  body: string;
}

/** Distinguish connection failures from listeners that accept but do not respond. */
type Unanswered = 'unreachable' | 'silent';

/** Require a complete response within an absolute deadline; trickling bytes must not delay hub startup indefinitely. */
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

    // Disable pooling so hub probes do not queue behind unrelated requests in the client process.
    const outbound = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (response) => {
      const chunks: Buffer[] = [];

      let size = 0;

      // Keep byte chunks for Node inspector compatibility; decoded strings lack byteLength (M28).
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.byteLength;

        if (size > ANSWER_LIMIT_BYTES) {
          done('silent');
        }
      });
      response.on('end', () => done({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
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

/** Retain unexpected response details for connection diagnostics. */
export interface Saw {
  status: number;
  said: string;
}

/** Bound the response excerpt to one notification line. */
const SAID_LIMIT = 60;

function saw(answer: Answer): Saw {
  const said = answer.body.replace(/\s+/g, ' ').trim();

  return { status: answer.status, said: said.length > SAID_LIMIT ? `${said.slice(0, SAID_LIMIT)}\u2026` : said };
}

/** Probe the recorded listener and return its response or connection failure. */
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

/** Authenticate the recorded hub regardless of protocol. Probe liveness because forced Windows exits leave stale records. Never send tokens to unverified listeners. */
export async function recordedHub(home: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<LiveHub | null> {
  const found = await findHub(home, timeoutMs);

  if ('hub' in found) {
    return found.hub;
  }

  // An authenticated hub with another protocol still prevents duplicate startup and may require replacement.
  return found.miss.why === 'another-protocol' ? found.miss.hub : null;
}

/** Classify discovery failures to provide accurate diagnostics and recovery steps. */
export type HubMiss =
  | { why: 'no-record' }
  | { why: 'unreachable'; record: HubRecord }
  | { why: 'silent'; record: HubRecord }
  | { why: 'not-a-hub'; record: HubRecord; saw: Saw }
  | { why: 'another-home'; record: HubRecord }
  | { why: 'unproven'; record: HubRecord }
  | { why: 'another-protocol'; hub: LiveHub };

export type Found = { hub: LiveHub } | { miss: HubMiss };

/** Return an authenticated hub or the discovery failure. Probe for liveness rather than trusting a potentially stale record. */
export async function findHub(home: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<Found> {
  const record = readHubRecord(home);

  if (record === null) {
    return { miss: { why: 'no-record' } };
  }

  const nonce = randomBytes(16).toString('base64url');
  let identity = await probe(record.port, timeoutMs, nonce);

  // Retry silent probes with more time; client startup or suspend can delay the event loop.
  if (identity === 'silent') {
    identity = await probe(record.port, SECOND_LOOK_MS, nonce);
  }

  if (typeof identity === 'string') {
    return { miss: { why: identity, record } };
  }

  if ('notAHub' in identity) {
    return { miss: { why: 'not-a-hub', record, saw: identity.notAHub } };
  }

  // Verify token possession as well as the home fingerprint; a home path alone cannot authenticate a listener.
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

/** Stop the authenticated hub regardless of protocol; shutdown uses the same route across versions. */
export async function stopHub(home: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const held = await recordedHub(home, timeoutMs);

  return held !== null && stopThisHub(held, timeoutMs);
}

/** Stop the discovered instance without rereading hub.json, which may now identify another client's replacement. */
export async function stopThisHub(hub: LiveHub, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const answer = await call(hub.record.port, 'POST', '/shutdown', hub.record.token, timeoutMs);

  return typeof answer !== 'string' && answer.status === 200;
}

/** Require equal protocol versions; the version changes only for incompatible messages. */
function protocolMatches(identity: HubIdentity): boolean {
  return identity.protocol === PROTOCOL;
}
