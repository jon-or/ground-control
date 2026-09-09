import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';

const ROOT = join(__dirname, '..');
const BOARD = 'https://github.com/orgs/example-org/projects/3';
const ISSUE = 'https://github.com/example-org/example-repo/issues/4501';
let context: BrowserContext;
let worker: Worker;
const directories: string[] = [];
const offsite: string[] = [];

beforeAll(async () => {
  const profile = mkdtempSync(join(tmpdir(), 'gc-watch-profile-'));
  const extension = mkdtempSync(join(tmpdir(), 'gc-watch-extension-'));
  directories.push(profile, extension);
  cpSync(ROOT, extension, { recursive: true, filter: (path) => !/node_modules|coverage/.test(path) });
  const manifestPath = join(extension, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { permissions: string[] };
  manifest.permissions = manifest.permissions.filter((permission) => permission !== 'nativeMessaging');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  expect(JSON.parse(readFileSync(manifestPath, 'utf8')).permissions).not.toContain('nativeMessaging');

  // Replace only the native boundary in the isolated copy. Track real content ports for reconnect tests.
  const workerPath = join(extension, 'src/worker.js');
  writeFileSync(workerPath, `
globalThis.probe = { messages: [], opens: 0, closes: 0, ports: [] };
chrome.runtime.onConnect.addListener(port => {
  probe.ports.push(port);
  const listeners = [];
  const add = port.onDisconnect.addListener.bind(port.onDisconnect);
  port.onDisconnect.addListener = listener => { listeners.push(listener); add(listener); };
  probe.dropContent = () => { port.disconnect(); listeners.forEach(listener => listener()); };
});
chrome.runtime.connectNative = () => {
  probe.opens++;
  const listeners = [];
  probe.drop = () => listeners.forEach(listener => listener());
  return {
    postMessage: message => probe.messages.push(message),
    disconnect: () => { probe.closes++; },
    onMessage: { addListener() {} },
    onDisconnect: { addListener: listener => listeners.push(listener) }
  };
};
` + readFileSync(workerPath, 'utf8'));

  // Headless Chromium does not consistently hide background tabs. Drive the visibility API in the
  // content script's isolated world; the production event handler and extension messaging remain real.
  const contentPath = join(extension, 'src/content.js');
  writeFileSync(contentPath, `
Object.defineProperty(document, 'visibilityState', {
  get: () => document.documentElement.dataset.testVisibility || 'visible'
});
` + readFileSync(contentPath, 'utf8'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const html = readFileSync(join(ROOT, 'test/fixtures/project-board.html'), 'utf8');
  await context.route((url) => url.protocol.startsWith('http'), (route) => {
    const url = route.request().url();
    if (url === BOARD || url === ISSUE) return route.fulfill({ contentType: 'text/html', body: html });
    offsite.push(url);
    return route.abort();
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
});

afterAll(async () => {
  await context?.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

async function watching(): Promise<boolean | null> {
  return worker.evaluate('probe.messages.filter(m => m.type === "watching").at(-1)?.watching ?? null');
}

async function visibility(page: Page, value: string): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.dataset.testVisibility = value;
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
}

it('aggregates visible project tabs across navigation, disconnects, and reconnects', async () => {
  const first = await context.newPage();
  await first.goto(ISSUE);
  await expect.poll(() => worker.evaluate('probe.ports.length'), { timeout: 20_000 }).toBe(1);
  expect(await worker.evaluate('probe.opens')).toBe(0);
  expect(await watching()).toBeNull();

  await first.evaluate((url) => {
    history.pushState({}, '', url);
    document.dispatchEvent(new Event('turbo:load'));
  }, BOARD);
  await expect.poll(watching).toBe(true);
  await expect.poll(() => first.locator('#gc-menu').count()).toBe(1);

  await visibility(first, 'hidden');
  await expect.poll(watching).toBe(false);
  expect(await worker.evaluate('probe.closes')).toBe(0);

  const second = await context.newPage();
  await second.goto(BOARD);
  await expect.poll(watching).toBe(true);
  await visibility(first, 'visible');
  await visibility(second, 'hidden');
  await expect.poll(watching).toBe(true);

  // A native reconnect must restore the aggregate, including when every project is hidden.
  await visibility(first, 'hidden');
  await expect.poll(watching).toBe(false);
  await worker.evaluate('probe.drop()');
  // A content reconnect also wakes the native connection, without waiting for the alarm interval.
  await worker.evaluate('probe.dropContent()');
  await expect.poll(() => worker.evaluate('probe.opens'), { timeout: 20_000 }).toBe(2);
  // The native port can reopen for the first tab before the second tab's delayed content reconnect.
  await expect.poll(() => worker.evaluate('probe.ports.length'), { timeout: 20_000 }).toBe(3);
  expect(await watching()).toBe(false);
  await visibility(second, 'visible');
  await expect.poll(watching).toBe(true);

  await second.close();
  await expect.poll(watching).toBe(false);
  await first.evaluate((url) => {
    history.pushState({}, '', url);
    document.dispatchEvent(new Event('turbo:load'));
  }, ISSUE);
  await expect.poll(() => worker.evaluate('probe.closes')).toBe(1);
  expect(await watching()).toBe(false);
  await visibility(first, 'visible');
  expect(await worker.evaluate('probe.opens')).toBe(2);
  await expect.poll(() => first.locator('#gc-menu').count()).toBe(0);

  await first.evaluate((url) => {
    history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, BOARD);
  await expect.poll(watching).toBe(true);
  await first.close();
  await expect.poll(() => worker.evaluate('probe.closes')).toBe(2);
  expect(await watching()).toBe(false);
  expect(offsite).toEqual([]);
});
