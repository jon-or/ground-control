# Ground Control GitHub overlay

Adds local lane, triage, and session information to matching issue cards on GitHub Projects. Uses the same hub snapshot as the VS Code board. Displays phase, duration, attention, failures, and freshness.

Session links open VS Code. Checkout opening requires a connected editor. The overlay can move local lanes and read logs; it cannot start or stop work, request classification, select filesystem paths, or open combined diffs. See [R36](../../docs/prd.md#r36-github-overlay).

## Loading

1. Run **Ground Control: Enable GitHub Overlay** in VS Code to register the native host and launcher. **Ground Control: Disable GitHub Overlay** removes them; uninstall does too. Registration targets Google Chrome.
2. Enable Developer mode at `chrome://extensions` and load this directory unpacked.

There is no build step. The manifest's public key fixes the extension ID used by native-host registration. After reloading the extension, reload existing GitHub tabs to replace invalidated content scripts.

## Implementation

| File | Responsibility | Verification |
|---|---|---|
| `src/overlay.js` | DOM matching, card rendering, menus, tooltips, and log panel | Vitest/jsdom and browser behavior tests |
| `src/state.js` | Snapshot state, page matching, retries, and log subscriptions | Vitest |
| `src/content.js` | Worker port, observer, and repaint scheduling | Headless Playwright |
| `src/worker.js` | Native port, tab ports, snapshot cache, and reconnect alarm | Headless Playwright |

The content script injects across github.com to support soft navigation, but renders only on supported project pages. JSDoc checks snapshot types against core. Unchanged footers are retained by card node and content signature; GitHub view changes replace nodes and require rebuilding.

The worker connects through native messaging and makes no direct GitHub API requests. It caches the latest snapshot in `chrome.storage.session`. Log lines remain in memory. The first sidebar subscribes to hub logs; the last closing sidebar unsubscribes and discards hub backfill.

**Show log** opens browser and hub diagnostics with source filters. Outside click closes it unless pinned. Refused-request origins are redacted, but other private operational text may remain visible to GitHub page scripts. See [data boundaries](../../docs/architecture.md#data-boundaries).

[Testing](../../docs/testing.md#chrome-integration) describes isolated extension loading, offline fixture routes, and native-host precautions.
