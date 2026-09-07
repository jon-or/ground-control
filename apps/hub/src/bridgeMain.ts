import { HubTransport, bridgeHello, makeEnsure, realEnsureDeps, runBridge } from '@ground-control/hub';
import type { BridgeMessage, BridgeStreams } from '@ground-control/hub';
import { startHub } from './machine.js';

/**
 * Chrome's own stdio. Held as an interface so the relay itself is driven by a test without a pair of pipes. `close`
 * and `error` end it as `end` does: a browser that died rather than closed the port leaves an orphan otherwise, one
 * that goes on retrying its transport and holding a client registration nothing will ever read.
 */
function chromeStreams(): BridgeStreams {
  return {
    onData: (handler) => process.stdin.on('data', handler),
    onEnd: (handler) => {
      for (const event of ['end', 'close', 'error'] as const) {
        process.stdin.on(event, handler);
      }
    },
    write: (frame) => process.stdout.write(frame),
  };
}

/**
 * The bridge Chrome starts for the overlay: one client of the hub, relaying both ways. It holds nothing — no
 * configuration to push and no route to perform — so what it adds over the VS Code client is the framing alone.
 */
export function startBridge(home: string): void {
  const id = `chrome-${process.pid}`;
  const streams = chromeStreams();

  let watching = false;
  let watchingLog = false;
  let toChrome: (message: BridgeMessage) => void = () => {};

  const transport = new HubTransport(id, {
    ensure: makeEnsure(realEnsureDeps(home, () => startHub(home))),
    hello: () => bridgeHello(id, watching),
    onMessage: (message) => toChrome(message),
    // This process is the browser board's client, and its log has nowhere else to go — so its own story is relayed
    // rather than written, from `info` up. The line per message is left out: each one costs a frame across Chrome's
    // port, and on this side the frames themselves are what it would be describing (R40).
    log: (level, message) => {
      if (level !== 'debug') {
        toChrome({ type: 'log', entries: [{ at: new Date().toISOString(), level, source: 'browser', scope: 'bridge', message }] });
      }
    },
    // No configuration — the browser pushes none, and a hub this bridge just started runs on its own defaults until
    // a VS Code window connects with the developer's. What does have to be said again is the log: the hello carries
    // whether a board is watching, and a hub restarted under the reconnect holds no log subscriber for this client,
    // so a sidebar left open in Chrome would go quiet for good (R40).
    afterHello: () => {
      if (watchingLog) {
        transport.send({ type: 'watchLog', watching: true });
      }
    },
    onTrouble: (message) => toChrome({ type: 'trouble', message }),
  });

  toChrome = runBridge({
    streams,
    send: (message) => {
      if (message.type === 'watching') {
        watching = message.watching;
      }

      if (message.type === 'watchLog') {
        watchingLog = message.watching;
      }

      transport.send(message);
    },
    stop: () => {
      transport.dispose();
      process.exit(0);
    },
  });
}
