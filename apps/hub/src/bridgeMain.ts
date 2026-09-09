import { HubTransport, bridgeHello, makeEnsure, realEnsureDeps, runBridge } from '@ground-control/hub';
import type { BridgeMessage, BridgeStreams } from '@ground-control/hub';
import { startHub } from './machine.js';

/**
 * Adapt Chrome stdio for the testable relay. End on close or error as well as end, so a browser crash stops
 * reconnects and releases the client registration.
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
 * Relay messages between Chrome and the hub using native-messaging framing. The bridge supplies no
 * configuration or routes.
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
    // Relay bridge logs at info level and above to Chrome. Exclude per-message debug logs to avoid extra frames
    // describing the same traffic (R40).
    log: (level, message) => {
      if (level !== 'debug') {
        toChrome({ type: 'log', entries: [{ at: new Date().toISOString(), level, source: 'browser', scope: 'bridge', message }] });
      }
    },
    // Restore the log subscription after reconnect; hello restores only board watching. The browser supplies no
    // configuration, so a new hub uses defaults until VS Code connects (R40).
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
