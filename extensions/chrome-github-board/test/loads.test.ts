import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME_EXTENSION_ID } from '@ground-control/core';
import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';

/**
 * What jsdom cannot answer: whether Chrome loads this directory at all, whether the content script's matches fire on
 * a project board, whether the worker starts, and whether the overlay module the content script imports is actually
 * reachable as a web-accessible resource. Every one of those is a manifest mistake that leaves no error anywhere a
 * unit test looks.
 */
const EXTENSION = join(__dirname, '..');
const BOARD = readFileSync(join(__dirname, 'fixtures', 'project-board.html'), 'utf8');

/**
 * The recorded board, served in place of GitHub's. It has to be answered at a `github.com` URL rather than a
 * `file://` one, because a content script's `matches` are the page's URL — off github.com nothing runs at all — and
 * the fulfilment is local, so the no-network rule holds.
 */
const BOARD_URL = 'https://github.com/orgs/example-org/projects/3/views/1';

/** Every other page on the site the content script is injected across, and must leave alone. */
const ISSUE_URL = 'https://github.com/example-org/example-repo/issues/4501';

interface Manifest {
  key: string;
  permissions: string[];
  background: { service_worker: string; type: string };
  content_scripts: { matches: string[]; js: string[] }[];
  web_accessible_resources: { resources: string[]; matches: string[] }[];
}

function manifest(where: string): Manifest {
  return JSON.parse(readFileSync(join(where, 'manifest.json'), 'utf8')) as Manifest;
}

/**
 * The shipped manifest is what Chrome is handed, and nothing below reads it — so it is asserted here, whole. A
 * permission added by hand is the extension asking for more of the developer's browser than it was reviewed for.
 */
describe('what the extension asks Chrome for', () => {
  const shipped = manifest(EXTENSION);

  it('asks for nothing beyond the bridge, the alarm and its own storage', () => {
    expect(shipped.permissions).toEqual(['nativeMessaging', 'alarms', 'storage']);
    expect(shipped).not.toHaveProperty('host_permissions');
  });

  /**
   * The whole site, because a board reached by clicking through it is a soft navigation Chrome injects nothing for
   * (`mechanics.md` §27). `isBoardPath` is what keeps the overlay off every other page, and the test below is what
   * proves it does.
   */
  it('runs its content script on github.com and nowhere else', () => {
    expect(shipped.content_scripts).toHaveLength(1);
    expect(shipped.content_scripts[0]?.matches).toEqual(['https://github.com/*']);
    expect(shipped.content_scripts[0]?.js).toEqual(['src/content.js']);
  });

  /** The content script imports both at runtime. A resource left out of this list resolves to nothing, silently. */
  it('lets the page reach the two modules the content script imports', () => {
    expect(shipped.web_accessible_resources[0]?.resources).toEqual(['src/overlay.js', 'src/state.js']);
  });
});

describe('the overlay as Chrome loads it', () => {
  let profile = '';
  let loaded = '';
  let context: BrowserContext;

  beforeAll(async () => {
    profile = mkdtempSync(join(tmpdir(), 'gc-chrome-'));

    /**
     * A copy with `nativeMessaging` taken out. A native host is registered per user rather than per profile, so on
     * a machine where the developer has enabled the overlay the worker would reach their real bridge, start a hub
     * against their real home, and this test would assert against their board. Without the permission the connect
     * throws, the worker says so, and every machine behaves the same way.
     */
    loaded = mkdtempSync(join(tmpdir(), 'gc-ext-'));
    cpSync(EXTENSION, loaded, {
      recursive: true,
      filter: (from) => !from.includes('node_modules') && !from.includes('coverage'),
    });

    const stripped = manifest(loaded);

    stripped.permissions = stripped.permissions.filter((name) => name !== 'nativeMessaging');
    writeFileSync(join(loaded, 'manifest.json'), JSON.stringify(stripped, null, 2));

    // Read back rather than assumed: a filter that stopped matching would leave this suite reaching the developer's
    // own bridge, and passing everywhere else.
    if (manifest(loaded).permissions.includes('nativeMessaging')) {
      throw new Error('The copy under test can still reach a native host.');
    }

    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${loaded}`, `--load-extension=${loaded}`],
    });

    await context.route('https://github.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: BOARD }),
    );
  });

  afterAll(async () => {
    await context?.close();

    // Named only once each is minted: a `beforeAll` that threw before then would otherwise take this down with it
    // and lose whatever went wrong.
    for (const made of [profile, loaded]) {
      if (made !== '') {
        rmSync(made, { recursive: true, force: true });
      }
    }
  });

  /**
   * Chrome derives the id from the public `key` in the manifest, and the native host lets in exactly one origin
   * built from `CHROME_EXTENSION_ID`. Nowhere else can see the real id, so asserting it against the constant the
   * source already uses would prove nothing — this is the only place the two are compared.
   */
  it('starts its background worker, at the id the native host lets in', async () => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

    expect(worker.url()).toBe(`chrome-extension://${CHROME_EXTENSION_ID}/src/worker.js`);
  });

  it('paints its banner onto a project board and says it cannot reach the hub', async () => {
    const page = await context.newPage();

    await page.goto(BOARD_URL);

    const banner = page.locator('#gc-banner');

    await expect.poll(() => banner.count(), { timeout: 20_000 }).toBe(1);

    // The worker cannot open its port to the bridge here. What the developer must see is that the badges are
    // missing because nothing answered — never a board that looks empty (R24, R25).
    await expect.poll(() => banner.textContent(), { timeout: 20_000 }).toMatch(/Ground Control is not/);

    expect(await page.locator('.gc-badge').count()).toBe(0);
    expect(await page.locator('[data-gc-issue]').count()).toBe(3);
  });

  /**
   * This route serves the same board markup at an issue URL, so only the path check can be what keeps the page
   * clean — an over-broad `matches` alone would leave this test green.
   */
  it('leaves every other page on the site alone', async () => {
    const page = await context.newPage();

    await page.goto(ISSUE_URL);
    await page.waitForTimeout(2000);

    expect(await page.locator('#gc-banner').count()).toBe(0);
    expect(await page.locator('[data-gc-issue]').count()).toBe(0);
  });
});
