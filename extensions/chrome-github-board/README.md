# Ground Control — GitHub board overlay

The board, painted onto the team's GitHub project board (`prd.md` R36). Each card that links to an issue you have a session on grows a badge: the lane Ground Control has it in, and a chip per session with its phase and how long that phase has held. Above the board sits one line carrying what R25 asks to be said once — what failed, what the activity install did, and how old the reading is.

It watches and it moves cards. It does not take a session over: that needs the editor (R14, R15), so the chip says where that happens rather than raising a window from a browser tab.

## Loading it

It is not on the Chrome Web Store. Two steps, in this order:

1. In VS Code, run **Ground Control: Enable GitHub Overlay**. That writes the native-messaging manifest, the wrapper Chrome starts, and on Windows the `HKCU` value Chrome finds the manifest by. **Ground Control: Disable GitHub Overlay** undoes all three, and uninstalling the extension does too. Google Chrome only: every other browser reads its own locations, and none has been asked for.
2. At `chrome://extensions`, turn on Developer mode and **Load unpacked** this directory.

There is no build step: what Chrome loads is what is in `src/`. The extension's id is fixed by the public `key` in `manifest.json`, so the native host's `allowed_origins` keeps matching wherever the directory is loaded from.

## The four files

| File | Holds | Reached by |
| --- | --- | --- |
| `src/overlay.js` | which cards match, what a badge says, what the banner says | vitest under jsdom, against the recorded board in `test/fixtures/` |
| `src/state.js` | what a worker message does to what is drawn, which pages are boards, how long to wait before trying again | vitest |
| `src/content.js` | the port to the worker, the mutation observer, and the repaint | the Playwright run — it is wiring, not decisions |
| `src/worker.js` | the native port to the hub, one port per board tab, and the alarm that reconnects | the same |

`overlay.js` and `state.js` import nothing and hold every decision the browser side makes. Both are typed against `packages/core` through JSDoc, so a field renamed in the protocol fails `npm run typecheck` here as well as in the editor's client.

The content script runs on every `github.com` page, because a board reached by clicking through the site is a soft navigation and Chrome injects nothing for one. `isBoardPath` is what keeps it off everything else, checked again on every repaint.

## Where the data comes from

No GitHub API call and no token. The worker opens a native-messaging port to `ground-control-hub --native-messaging`, which is another client of the same hub the VS Code board talks to — so a hook firing repaints the badge here and the card there from one reading of the machine (R35). The worker keeps the last snapshot in `chrome.storage.session` and nowhere else, so it goes when Chrome does.
