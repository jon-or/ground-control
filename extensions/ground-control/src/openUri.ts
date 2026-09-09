import * as vscode from 'vscode';
import { agentOfSession, sessionOf } from '@ground-control/core';
import type { Session } from '@ground-control/core';
import { attachFromUri, handedOver, sessionFromUri } from '@ground-control/host-vscode';
import { attachTo } from './attach.js';
import { client } from './hubClient.js';
import { agentExtensionReady } from './resident.js';

/**
 * The board's second entry point: a `vscode://groundcontrol.ground-control/open?session=…` navigation from the browser
 * overlay. It exists because focus cannot be taken, only given — a navigation raises VS Code and hands this window
 * the foreground, which is what every route then needs (`docs/mechanics.md` §26, §29).
 *
 * The link is reachable from any page, so this takes one well-formed id, an agent where the board named one, and nothing else. An open goes through the hub, which resolves the id against its live roster and saved history and refuses what it does not know. An attach is this window's own terminal, so it resolves the id the same way and refuses it here.
 */
export function registerUriHandler(): vscode.Disposable {
  return vscode.window.registerUriHandler({
    async handleUri(uri: vscode.Uri): Promise<void> {
      // Before the open read, and never through the hub: a detached run is entered by attaching to it, which is
      // this window's own terminal rather than a surface the hub could route to.
      const attaching = attachFromUri(uri.path, uri.query);

      if (attaching !== null) {
        await attach(attaching);

        return;
      }

      const sessionId = sessionFromUri(uri.path, uri.query);

      if (sessionId === null) {
        void vscode.window.showWarningMessage('That link does not name a session Ground Control can open.');

        return;
      }

      // Activation builds the client before it registers this handler, and VS Code delivers a URI only once
      // activation has settled — so there is no window in which this window has no client to send through.
      const held = client();

      // Which extension has to be up is the session's own agent's. A hand-over names it in the URI, because the
      // window the board raised may never have had a board open and so may hold no snapshot to read it from; a link
      // a developer clicked is read off the snapshot, and falls back to Claude where this window has none.
      const handed = handedOver(uri.query);
      const agent = handed ?? agentOfSession(held?.snapshot, sessionId);

      // A hand-over goes through the hub like any other open. The hub is local and every window can reach it, and
      // it is what proves the session exists, which surface holds it, and whether a resume is allowed — none of
      // which a link can prove, and this link is reachable from any page in the browser.
      held?.send({
        type: 'open',
        sessionId,
        extensionReady: await agentExtensionReady(agent),
        ...(handed === null ? {} : { handedOver: true }),
      });
    },
  });
}

/** How long a link is given to find its run. A cold window registers its hub in 3.2s (`docs/mechanics.md` §8). */
const ATTACH_DEADLINE_MS = 8_000;

async function attach(sessionId: string): Promise<void> {
  const known = await runNamed(sessionId);

  if (!known || !attachTo(known)) {
    void vscode.window.showWarningMessage('That run is no longer on this machine, or is not one the board can attach to.');
  }
}

/**
 * The run a link named, from this window's own board where it has one and from the hub's roster otherwise: a window
 * the navigation raised may never have had a board open, so the snapshot is not there to read.
 *
 * A URI is an activation event, so this can run before the client has a connection at all — and until it has one,
 * `roster()` answers null rather than an empty list. Null is asked again; a list is the whole answer, so a run absent
 * from one is absent, and only a deadline ends the wait for a hub that never answers.
 */
async function runNamed(sessionId: string): Promise<Session | null> {
  const held = client();

  if (!held) {
    return null;
  }

  for (const deadline = Date.now() + ATTACH_DEADLINE_MS; ; ) {
    const shown = sessionOf(held.snapshot, sessionId);

    if (shown) {
      return shown;
    }

    const roster = await held.roster();

    if (roster !== null) {
      return roster.find((session) => session.sessionId === sessionId) ?? null;
    }

    if (Date.now() >= deadline) {
      return null;
    }

    await new Promise((wake) => setTimeout(wake, 500));
  }
}
