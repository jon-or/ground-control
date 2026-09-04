import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL, groundControlDirOf } from '@ground-control/core';
import { fingerprintOf, liveHub, probeHub, readHubRecord, recordedHub, stopHub, stopThisHub, unprovenHub } from '../src/discover.js';
import { proofOf } from '../src/server.js';
import { hubJsonPathOf } from '../src/paths.js';
import { tempHome } from './helpers.js';

const TOKEN = 'the-token-nobody-else-gets';

const shut: (() => void)[] = [];

afterEach(() => {
  while (shut.length) {
    shut.pop()?.();
  }
});

interface Listener {
  port: number;
  /** Every request it saw, verbatim. Pinned by contents rather than scanned, so an empty list proves nothing. */
  asked: string[];
}

function listening(handle: Parameters<typeof createServer>[1]): Promise<Listener> {
  const asked: string[] = [];
  const server: Server = createServer((incoming, response) => {
    asked.push(`${incoming.method} ${incoming.url?.replace(/nonce=[^&]+/, 'nonce=…')} ${incoming.headers.authorization ?? 'no-token'}`);
    handle?.(incoming, response);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      shut.push(() => {
        server.close();
        server.closeAllConnections();
      });
      resolve({ port: (server.address() as { port: number }).port, asked });
    });
  });
}

/** Anything holding the port a dead hub used to. Answers whatever it is told to, including a forged identity. */
function foreignListener(answer: unknown, status = 200): Promise<Listener> {
  return listening((_incoming, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(typeof answer === 'string' ? answer : JSON.stringify(answer));
  });
}

/** A listener that answers as a hub for this home, proving the token only when `token` is the one it holds. */
function hubListener(home: string, over: { token?: string; protocol?: number } = {}): Promise<Listener> {
  return listening((incoming, response) => {
    const nonce = new URL(incoming.url ?? '/', 'http://127.0.0.1').searchParams.get('nonce');
    const identity = {
      hub: 'ground-control',
      protocol: over.protocol ?? PROTOCOL,
      fingerprint: fingerprintOf(home),
      ...(nonce && over.token ? { proof: proofOf(over.token, nonce) } : {}),
    };

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(identity));
  });
}

function writeRecord(home: string, over: Record<string, unknown>): void {
  mkdirSync(groundControlDirOf(home), { recursive: true });
  writeFileSync(
    hubJsonPathOf(home),
    JSON.stringify({
      protocol: PROTOCOL,
      version: '0.0.0',
      port: 1,
      token: TOKEN,
      pid: 1,
      startedAt: '2026-09-03T10:00:00.000Z',
      fingerprint: fingerprintOf(home),
      ...over,
    }),
  );
}

describe('which hub this is', () => {
  it('is the configuration directory, so two homes never share one', () => {
    // Pinned, rather than compared against the same call: an assertion the source computes both sides of holds
    // whatever the source does.
    expect(fingerprintOf('d:/users/one')).toBe(
      createHash('sha256').update('d:/users/one/.claude/ground-control').digest('hex').slice(0, 16),
    );
    expect(fingerprintOf('d:/users/one')).not.toBe(fingerprintOf('d:/users/two'));
  });

  /** The fingerprint says which home; a home path is guessable, so only this says the listener minted the record. */
  it('proves possession of the token without disclosing it', () => {
    expect(proofOf(TOKEN, 'a-nonce')).toBe(proofOf(TOKEN, 'a-nonce'));
    expect(proofOf(TOKEN, 'a-nonce')).not.toBe(proofOf(TOKEN, 'another-nonce'));
    expect(proofOf(TOKEN, 'a-nonce')).not.toBe(proofOf('a-different-token', 'a-nonce'));
    expect(proofOf(TOKEN, 'a-nonce')).not.toContain(TOKEN);
  });
});

describe('reading the record a hub left', () => {
  it('reads one a hub wrote', () => {
    const { home, dispose } = tempHome();

    try {
      writeRecord(home, { port: 4321 });

      expect(readHubRecord(home)?.port).toBe(4321);
    } finally {
      dispose();
    }
  });

  /** A hub mid-write, a hub from a version that wrote something else, and no hub at all are all the same answer. */
  it('reads nothing rather than half a record', () => {
    const { home, dispose } = tempHome();

    try {
      expect(readHubRecord(home)).toBeNull();

      mkdirSync(groundControlDirOf(home), { recursive: true });
      writeFileSync(hubJsonPathOf(home), '{"port": 43');
      expect(readHubRecord(home)).toBeNull();

      writeFileSync(hubJsonPathOf(home), JSON.stringify({ port: 4321 }));
      expect(readHubRecord(home)).toBeNull();

      writeRecord(home, { port: 0 });
      expect(readHubRecord(home)).toBeNull();
    } finally {
      dispose();
    }
  });
});

describe('asking a port what it is', () => {
  it('reads a hub that answers as one', async () => {
    const listener = await foreignListener({ hub: 'ground-control', protocol: PROTOCOL, fingerprint: 'abc' });

    expect(await probeHub(listener.port)).toEqual({ hub: 'ground-control', protocol: PROTOCOL, fingerprint: 'abc' });
    expect(listener.asked).toEqual(['GET /hub no-token']);
  });

  it('reads nothing from a listener that is not a hub, and from a port nothing holds', async () => {
    const notJson = await foreignListener('<html>a dev server</html>');
    const wrongShape = await foreignListener({ hub: 'something-else', protocol: 1, fingerprint: 'abc' });
    const refusing = await foreignListener({ hub: 'ground-control', protocol: 1, fingerprint: 'abc' }, 500);

    expect(await probeHub(notJson.port)).toBeNull();
    expect(await probeHub(wrongShape.port)).toBeNull();
    expect(await probeHub(refusing.port)).toBeNull();
    expect(await probeHub(1, 200)).toBeNull();
  });

  /** The deadline is what a hub waits on before it binds, so a listener that never finishes must not hold it there. */
  it('gives up on a listener that accepts and says nothing', async () => {
    const silent = await listening(() => {});
    const started = Date.now();

    expect(await probeHub(silent.port, 300)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  /**
   * A socket's own timeout is reset by every byte, so a listener trickling faster than it resets it forever. Anything
   * that took a dead hub's port and streams — a dev server, a log tailer — would otherwise hang the next hub start.
   */
  it('gives up on a listener that answers forever', async () => {
    const trickle = await listening((_incoming, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });

      const beat = setInterval(() => response.write('x'), 20);

      shut.push(() => clearInterval(beat));
      response.on('close', () => clearInterval(beat));
    });
    const started = Date.now();

    expect(await probeHub(trickle.port, 300)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('the hub a home already has', () => {
  it('is the one answering on the recorded port that proves it minted the record', async () => {
    const { home, dispose } = tempHome();

    try {
      const listener = await hubListener(home, { token: TOKEN });

      writeRecord(home, { port: listener.port });

      expect((await liveHub(home))?.record.port).toBe(listener.port);
      expect(listener.asked).toEqual(['GET /hub?nonce=… no-token']);
    } finally {
      dispose();
    }
  });

  /**
   * The token is the developer's snapshot, and the fingerprint is a hash of a path anyone on the machine can guess.
   * A listener that cannot prove it holds the token is not one to send it to, however right it looks.
   */
  it('is nothing when the listener cannot prove it holds the token, and no token is sent', async () => {
    const { home, dispose } = tempHome();

    try {
      const silent = await hubListener(home);
      const wrong = await hubListener(home, { token: 'a-token-it-made-up' });

      writeRecord(home, { port: silent.port });
      expect(await liveHub(home)).toBeNull();
      expect(await stopHub(home)).toBe(false);

      writeRecord(home, { port: wrong.port });
      expect(await liveHub(home)).toBeNull();
      expect(await stopHub(home)).toBe(false);

      expect(silent.asked).toEqual(['GET /hub?nonce=… no-token', 'GET /hub?nonce=… no-token']);
      expect(wrong.asked).toEqual(['GET /hub?nonce=… no-token', 'GET /hub?nonce=… no-token']);
    } finally {
      dispose();
    }
  });

  it('is nothing when the listener is a hub for another home', async () => {
    const { home, dispose } = tempHome();

    try {
      const listener = await hubListener('d:/somebody-else', { token: TOKEN });

      writeRecord(home, { port: listener.port });

      expect(await liveHub(home)).toBeNull();
      expect(listener.asked).toEqual(['GET /hub?nonce=… no-token']);
    } finally {
      dispose();
    }
  });

  /** A hub of another protocol reads this one's messages wrong; connecting to it is worse than starting a new one. */
  it('is nothing when the listener speaks another protocol', async () => {
    const { home, dispose } = tempHome();

    try {
      const listener = await hubListener(home, { token: TOKEN, protocol: PROTOCOL + 1 });

      writeRecord(home, { port: listener.port });

      expect(await liveHub(home)).toBeNull();
    } finally {
      dispose();
    }
  });

  /** Liveness is the probe, never the file: a hub killed on Windows never gets to remove its own record. */
  it('is nothing when the record is stale', async () => {
    const { home, dispose } = tempHome();

    try {
      writeRecord(home, { port: 1 });

      expect(await liveHub(home, 200)).toBeNull();
      expect(await stopHub(home, 200)).toBe(false);
    } finally {
      dispose();
    }
  });
});

describe('stopping the hub a home has', () => {
  it('asks it, with the token from its own record', async () => {
    const { home, dispose } = tempHome();

    try {
      const listener = await hubListener(home, { token: TOKEN });

      writeRecord(home, { port: listener.port });

      expect(await stopHub(home)).toBe(true);
      expect(listener.asked).toEqual(['GET /hub?nonce=… no-token', `POST /shutdown Bearer ${TOKEN}`]);
    } finally {
      dispose();
    }
  });

  it('reports a hub that would not stop', async () => {
    const { home, dispose } = tempHome();

    try {
      const listener = await listening((incoming, response) => {
        const nonce = new URL(incoming.url ?? '/', 'http://127.0.0.1').searchParams.get('nonce');

        if (incoming.url?.startsWith('/hub')) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(
            JSON.stringify({
              hub: 'ground-control',
              protocol: PROTOCOL,
              fingerprint: fingerprintOf(home),
              proof: proofOf(TOKEN, nonce ?? ''),
            }),
          );

          return;
        }

        response.writeHead(500);
        response.end('no');
      });

      writeRecord(home, { port: listener.port });

      expect(await stopHub(home)).toBe(false);
    } finally {
      dispose();
    }
  });
});

/**
 * A hub that is up and holds a token this client's record cannot prove is invisible to `liveHub`, and a client that
 * spawns one of its own then watches it stand down learns nothing. This is what lets the failure name it instead.
 */
describe('something answering for this home that a client cannot prove', () => {
  it('is named by the record it left, and never sent the token', async () => {
    const { home, dispose } = tempHome();

    try {
      const listener = await hubListener(home);

      writeRecord(home, { port: listener.port, pid: 4242 });

      expect(await liveHub(home)).toBeNull();
      expect(await unprovenHub(home)).toMatchObject({ port: listener.port, pid: 4242 });
      // No nonce either: a proof this client has nothing to check against is one it has no business asking for.
      expect(listener.asked).toEqual(['GET /hub?nonce=… no-token', 'GET /hub no-token']);
    } finally {
      dispose();
    }
  });

  /** Something else on the port is not a hub in the way, and saying it is would send the developer after nothing. */
  it('is nothing when the port is held by something else', async () => {
    const { home, dispose } = tempHome();

    try {
      const listener = await foreignListener({ hub: 'something-else' });

      writeRecord(home, { port: listener.port });

      expect(await unprovenHub(home)).toBeNull();
    } finally {
      dispose();
    }
  });

  /** A hub for another home is another developer's. Naming it would send this one to stop a board that is not theirs. */
  it('is nothing when the hub answering runs against another home', async () => {
    const { home, dispose } = tempHome();

    try {
      const listener = await hubListener('d:/somebody/else');

      writeRecord(home, { port: listener.port });

      expect(await unprovenHub(home)).toBeNull();
    } finally {
      dispose();
    }
  });

  /** No record is no port to probe. A hub that never started is not something standing in this client's way. */
  it('is nothing when no hub has left a record at all', async () => {
    const { home, dispose } = tempHome();

    try {
      expect(await unprovenHub(home)).toBeNull();
    } finally {
      dispose();
    }
  });
});

/**
 * Between finding a hub and standing it down, another client's replacement can hold the record. A stop that re-read
 * the file would then kill the hub this client was about to connect to, which is the shape of every rebuild once a
 * client stops one for running an older bundle.
 */
describe('stopping one particular hub', () => {
  it('goes to the record it was handed, whatever the file says by then', async () => {
    const { home, dispose } = tempHome();

    try {
      const held = await hubListener(home, { token: TOKEN });
      const replacement = await hubListener(home, { token: 'the-replacement-token' });

      writeRecord(home, { port: held.port });

      const found = await recordedHub(home);

      expect(found).not.toBeNull();

      // The record moves under it, the way a replacement's would.
      writeRecord(home, { port: replacement.port, token: 'the-replacement-token' });

      await stopThisHub(found!);

      expect(held.asked).toContain(`POST /shutdown Bearer ${TOKEN}`);
      expect(replacement.asked.some((line) => line.startsWith('POST /shutdown'))).toBe(false);
    } finally {
      dispose();
    }
  });
});
