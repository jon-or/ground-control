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
  let toChrome: (message: BridgeMessage) => void = () => {};

  const transport = new HubTransport(id, {
    ensure: makeEnsure(realEnsureDeps(home, () => startHub(home))),
    hello: () => bridgeHello(id, watching),
    onMessage: (message) => toChrome(message),
    // Nothing to restate: the browser pushes no configuration, and the hub it may have just started runs on its own
    // defaults until a VS Code window connects with the developer's settings.
    afterHello: () => {},
    onTrouble: (message) => toChrome({ type: 'trouble', message }),
  });

  toChrome = runBridge({
    streams,
    send: (message) => {
      if (message.type === 'watching') {
        watching = message.watching;
      }

      transport.send(message);
    },
    stop: () => {
      transport.dispose();
      process.exit(0);
    },
  });
}
