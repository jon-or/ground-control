const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { request } = require('node:http');
const { join } = require('node:path');
const vscode = require('vscode');

const home = process.env.GC_TEST_HOME;
const hubJson = join(home, '.claude', 'ground-control', 'hub.json');

/** Never throws: a hub mid-write, a hub killed, and no hub at all are all "nothing to reach yet". */
function record() {
  try {
    return JSON.parse(readFileSync(hubJson, 'utf8'));
  } catch {
    return null;
  }
}

function call(port, path, token, method = 'GET') {
  return new Promise((resolve) => {
    const headers = { Host: `127.0.0.1:${port}` };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
      headers['Content-Type'] = 'application/json';
    }

    const outbound = request({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });

    outbound.on('error', () => resolve(null));
    outbound.end(method === 'POST' ? '{}' : undefined);
  });
}

async function until(what, why, within = 30_000) {
  const deadline = Date.now() + within;

  for (;;) {
    const answer = await what();

    if (answer) {
      return answer;
    }

    assert.ok(Date.now() < deadline, why);
    await new Promise((done) => setTimeout(done, 200));
  }
}

const api = () => vscode.extensions.getExtension('ownerrez.ground-control').activate();

describe('the hub as its own process', () => {
  /**
   * R35: the board's tracking runs in a background process this window starts. Everything below is what no unit test
   * can see — that a real extension host spawns a real process, and that the two speak over a real socket.
   */
  it('is started by the extension, and is not the extension host', async () => {
    await api();

    const started = await until(() => record(), 'no hub.json was ever written for this window');

    assert.notStrictEqual(started.pid, process.pid, 'the hub is running inside the extension host');
    assert.strictEqual(started.protocol, 1);

    const identity = await until(
      async () => {
        const answer = await call(started.port, '/hub', null);

        return answer?.status === 200 ? JSON.parse(answer.body) : null;
      },
      'the recorded port never answered as a hub',
    );

    assert.strictEqual(identity.hub, 'ground-control');
    assert.strictEqual(identity.fingerprint, started.fingerprint);
  });

  it('refuses its own port to anything without the token', async () => {
    const started = await until(() => record(), 'no hub is running');

    assert.strictEqual((await call(started.port, '/snapshot', null)).status, 401);
    assert.strictEqual((await call(started.port, '/snapshot', 'not-the-token')).status, 401);
    assert.strictEqual((await call(started.port, '/snapshot', started.token)).status, 200);
  });

  /** The board renders what came over that socket; before it arrives there is no snapshot, which is not an error. */
  it('is where this window gets its board from', async () => {
    await vscode.commands.executeCommand('groundControl.openBoard');

    const seen = await until(async () => (await api()).snapshot(), 'no snapshot ever reached this window');

    assert.ok(Array.isArray(seen.lanes), 'the snapshot had no lanes');
  });

  /**
   * A hub killed under a live board has to come back, and the restart budget must not be what stops it — the budget
   * counts hubs that never start, and this one had already started.
   */
  it('is started again when a running one is stopped under a live board', async () => {
    const before = await until(() => record(), 'no hub is running');

    await call(before.port, '/shutdown', before.token, 'POST');

    const after = await until(
      () => {
        const now = record();

        return now && now.pid !== before.pid ? now : null;
      },
      'the hub was stopped and no new one was ever started',
      60_000,
    );

    assert.strictEqual((await call(after.port, '/snapshot', after.token)).status, 200);
  });
});
