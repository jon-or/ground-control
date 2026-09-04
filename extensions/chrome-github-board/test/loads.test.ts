import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

/** Every other page on the site the content script is now injected across, and must leave alone. */
const ISSUE_URL = 'https://github.com/example-org/example-repo/issues/4501';

describe('the overlay as Chrome loads it', () => {
  let profile: string;
  let context: BrowserContext;

  beforeAll(async () => {
    profile = mkdtempSync(join(tmpdir(), 'gc-chrome-'));
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });

    await context.route('https://github.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: BOARD }),
    );
  });

  afterAll(async () => {
    await context?.close();
    rmSync(profile, { recursive: true, force: true });
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

    // No native host is registered in this profile, so the worker's port to the bridge cannot open. What the
    // developer must see is that the badges are missing because nothing answered — never a board that looks empty.
    await expect.poll(() => banner.textContent(), { timeout: 20_000 }).toMatch(/Ground Control is not/);

    expect(await page.locator('.gc-badge').count()).toBe(0);
    expect(await page.locator('[data-gc-issue]').count()).toBe(3);
  });

  /**
   * The content script matches the whole site, because a board reached by clicking through it is a soft navigation
   * Chrome injects nothing for. What must not follow is an overlay on every issue and pull request — this route
   * serves the same board markup, so only the path check can be what keeps the page clean.
   */
  it('leaves every other page on the site alone', async () => {
    const page = await context.newPage();

    await page.goto(ISSUE_URL);
    await page.waitForTimeout(2000);

    expect(await page.locator('#gc-banner').count()).toBe(0);
    expect(await page.locator('[data-gc-issue]').count()).toBe(0);
  });
});
