import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Snapshot } from '@ground-control/core';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';

const ROOT = join(__dirname, '..');
const BOARD = 'https://github.com/orgs/example-org/projects/3';
const OTHER = 'https://github.com/orgs/example-org/projects/30';
const USER = 'https://github.com/users/example-org/projects/3';
const OWNER = 'https://github.com/orgs/another-org/projects/3';
const ISSUE = 'https://github.com/example-org/example-repo/issues/4501';
const ROUTES = new Set([BOARD, OTHER, USER, OWNER, ISSUE]);
let context: BrowserContext;
let worker: Worker;
let extension = '';
let profile = '';
const offsite: string[] = [];

const reading: Snapshot = {
  lanes: [{ id: 'build', title: 'Build', cards: [{
    key: 'issue-4501', issueNumber: 4501, sessions: [], lane: 'build', returned: false,
    attention: null, reason: '',
    issue: {
      number: 4501, title: 'Quote email drops rows past the first page', type: null, typeColor: null,
      url: 'https://github.com/example-org/example-repo/issues/4501', status: null, statusColor: null,
      statusChangedAt: null, assignees: [], pullRequest: null, updatedAt: '2026-09-09T12:00:00Z',
      avatar: { login: 'reviewer', source: 'pull-request', url: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==' },
    },
  }] }],
  issues: { count: 1, matched: 1, totalAssigned: 1, notOnProject: 0, truncated: false, fetchedAt: '' },
  sessions: { count: 0, patternError: null, fetchedAt: '' }, openable: [], startable: [], hooks: null,
  failures: [], stale: false, needs: null, fetchedAt: '2026-09-09T12:00:00Z',
};

async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  // Retain the recorded markup; a role variation verifies restoring an existing accessible role.
  const fixture = readFileSync(join(ROOT, 'test/fixtures/project-board.html'), 'utf8')
    .replace('<figure ', '<figure role="group" ');
  await context.route((url) => url.protocol.startsWith('http'), (route) => {
    if (ROUTES.has(route.request().url())) return route.fulfill({ contentType: 'text/html', body: fixture });
    offsite.push(route.request().url());
    return route.abort();
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
}

beforeEach(async () => {
  offsite.length = 0;
  profile = mkdtempSync(join(tmpdir(), 'gc-preferences-profile-'));
  extension = mkdtempSync(join(tmpdir(), 'gc-preferences-extension-'));
  cpSync(ROOT, extension, { recursive: true, filter: (path) => !/node_modules|coverage/.test(path) });
  const path = join(extension, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { permissions: string[] };
  manifest.permissions = manifest.permissions.filter((permission) => permission !== 'nativeMessaging');
  writeFileSync(path, JSON.stringify(manifest));
  expect(JSON.parse(readFileSync(path, 'utf8')).permissions).not.toContain('nativeMessaging');

  const workerPath = join(extension, 'src/worker.js');
  writeFileSync(workerPath, `
globalThis.probe = { ports: [], messages: [], deliveries: [], reports: [], opens: 0, closes: 0 };
chrome.runtime.onConnect.addListener(port => {
  const id = probe.ports.length;
  probe.ports.push(port);
  const post = port.postMessage.bind(port);
  port.postMessage = message => { probe.deliveries.push({ id, message }); post(message); };
  port.onMessage.addListener(message => probe.reports.push({ id, message }));
  const disconnected = [];
  const add = port.onDisconnect.addListener.bind(port.onDisconnect);
  port.onDisconnect.addListener = listener => { disconnected.push(listener); add(listener); };
  probe.dropContent = index => {
    if (index !== id) return;
    port.disconnect();
    disconnected.forEach(listener => listener());
  };
});
chrome.runtime.connectNative = () => {
  probe.opens++;
  const messages = [], disconnected = [];
  probe.emit = message => messages.forEach(listener => listener(message));
  probe.dropNative = () => disconnected.forEach(listener => listener());
  return {
    postMessage: message => probe.messages.push(message),
    disconnect: () => { probe.closes++; },
    onMessage: { addListener: listener => messages.push(listener) },
    onDisconnect: { addListener: listener => disconnected.push(listener) }
  };
};
` + readFileSync(workerPath, 'utf8'));
  const contentPath = join(extension, 'src/content.js');
  // Headless tabs have inconsistent visibility. Exercise real handlers with deterministic visibility
  // and suspended frames; preferences must clear a hidden page without waiting for a frame.
  writeFileSync(contentPath, `
Object.defineProperty(document, 'visibilityState', {
  get: () => document.documentElement.dataset.testVisibility || 'visible'
});
const originalFrame = requestAnimationFrame.bind(globalThis);
const heldFrames = [];
globalThis.requestAnimationFrame = callback => document.documentElement.dataset.testVisibility === 'hidden'
  ? (heldFrames.push(callback), 0) : originalFrame(callback);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') heldFrames.splice(0).forEach(callback => originalFrame(callback));
});
const heldPreferences = [];
const addStorageListener = chrome.storage.onChanged.addListener.bind(chrome.storage.onChanged);
chrome.storage.onChanged.addListener = listener => addStorageListener((changes, area) => {
  if (area === 'local' && document.documentElement.dataset.holdPreferences === 'true') {
    heldPreferences.push(() => listener(changes, area));
  } else listener(changes, area);
});
document.addEventListener('releasePreferences', () => heldPreferences.splice(0).forEach(deliver => deliver()));
` + readFileSync(contentPath, 'utf8'));
  await launch();
});

afterEach(async () => {
  await context?.close();
  for (const path of [profile, extension]) if (path) rmSync(path, { recursive: true, force: true });
  expect(offsite).toEqual([]);
});

async function preferences(enabled: boolean, projects: string[] = []) {
  await worker.evaluate(async (value) => {
    await (globalThis as any).chrome.storage.local.set({ preferences: value });
  }, { enabled, projects });
}

async function pageAt(url = BOARD) {
  const page = await context.newPage();
  await page.goto(url);
  await expect.poll(() => worker.evaluate('probe.reports.length')).toBeGreaterThan(0);
  return page;
}

async function shown(page: Page, enabled: boolean) {
  await expect.poll(() => page.locator('#gc-menu').count(), { timeout: 20_000 }).toBe(enabled ? 1 : 0);
}

async function options() {
  const page = await context.newPage();
  await page.goto(worker.url().replace('src/worker.js', 'options.html'));
  await expect.poll(() => page.getByRole('status').textContent()).not.toBe('Loading preferences…');
  return page;
}

async function emit() {
  await worker.evaluate((snapshot) => {
    (globalThis as any).probe.emit({ type: 'snapshot', snapshot });
  }, reading);
}

async function holdCachedSnapshot() {
  await worker.evaluate(async (snapshot) => {
    const api = (globalThis as any).chrome;
    const probe = (globalThis as any).probe;
    snapshot.lanes[0]!.cards[0]!.issue!.avatar!.login = 'cached-reviewer';
    await api.storage.session.set({ last: { type: 'snapshot', snapshot } });
    const get = api.storage.session.get.bind(api.storage.session);
    let first = true;
    api.storage.session.get = async (key: string) => {
      const result = await get(key);
      if (key === 'last' && first) {
        first = false;
        probe.cacheReads = 1;
        await new Promise<void>((resolve) => { probe.releaseCache = resolve; });
      }
      return result;
    };
  }, reading);
}

async function navigate(page: Page, url: string) {
  await page.evaluate((url) => {
    history.pushState({}, '', url);
    document.dispatchEvent(new Event('turbo:load'));
  }, url);
}

it('saves accessible options, rejects invalid URLs, and preserves disabled startup after browser restart', async () => {
  const board = await pageAt();
  await shown(board, true);
  await board.locator('#gc-menu button').first().click();
  const opened = context.waitForEvent('page');
  await board.getByRole('menuitem', { name: 'Overlay settings', exact: true }).click();
  const settings = await opened;
  await settings.waitForURL(worker.url().replace('src/worker.js', 'options.html'));
  await expect.poll(() => settings.getByRole('status').textContent()).not.toBe('Loading preferences…');
  expect(await worker.evaluate('probe.messages.filter(m => m.type === "openOptions" || m.type === "configure")')).toEqual([]);
  expect(await settings.getByLabel('Enable overlay', { exact: true }).isChecked()).toBe(true);
  expect(await settings.locator('a[href^="vscode:"]').getAttribute('href')).toBe('vscode://settings/groundControl.github.repo');
  await settings.getByLabel('Allowed project URLs', { exact: true }).fill('https://example.test/orgs/example-org/projects/3');
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => settings.getByRole('alert').textContent()).toMatch(/GitHub|github|project|URL/);
  expect(await worker.evaluate('chrome.storage.local.get("preferences").then(held => held.preferences)')).toBeUndefined();
  await settings.getByLabel('Allowed project URLs', { exact: true }).fill('https://github.com/orgs/EXAMPLE-ORG/projects/3/views/2?filter=test');
  await settings.getByLabel('Enable overlay', { exact: true }).uncheck();
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await shown(board, false);
  expect(await worker.evaluate('chrome.storage.local.get("preferences").then(held => held.preferences)'))
    .toEqual({ enabled: false, projects: [BOARD] });

  await context.close();
  await launch();
  const restarted = await pageAt();
  await expect.poll(() => worker.evaluate('probe.ports.length')).toBeGreaterThan(0);
  await shown(restarted, false);
  expect(await worker.evaluate('probe.opens')).toBe(0);
  const restored = await options();
  expect(await restored.getByLabel('Enable overlay', { exact: true }).isChecked()).toBe(false);
  expect(await restored.getByLabel('Allowed project URLs', { exact: true }).inputValue()).toBe(BOARD);
});

it('matches exact projects across open tabs and soft navigation without delivering private data to other projects', async () => {
  await preferences(true, [BOARD]);
  const allowed = await pageAt();
  await shown(allowed, true);
  const others: Page[] = [];
  for (const url of [OTHER, USER, OWNER]) {
    const page = await pageAt(url);
    others.push(page);
    await shown(page, false);
  }
  await expect.poll(() => worker.evaluate('probe.ports.length')).toBe(4);
  await emit();
  await expect.poll(() => allowed.locator('.gc-badge').count()).toBe(1);
  expect(await worker.evaluate('probe.deliveries.filter(d => d.id !== 0 && ["snapshot", "changed", "log"].includes(d.message.type))')).toEqual([]);
  await navigate(others[0]!, BOARD);
  await shown(others[0]!, true);
  await expect.poll(() => others[0]!.locator('.gc-badge').count()).toBe(1);
  await navigate(allowed, ISSUE);
  await shown(allowed, false);
  await preferences(true, [USER]);
  await shown(others[0]!, false);
  await shown(others[1]!, true);
  await shown(others[2]!, false);
});

it('clears hidden tabs immediately, restores GitHub markup, unsubscribes logs, and rejects stale deliveries', async () => {
  const board = await pageAt();
  await shown(board, true);
  await emit();
  await expect.poll(() => board.locator('.gc-actor').count()).toBe(1);
  await worker.evaluate('probe.stale = structuredClone(probe.deliveries.find(d => d.message.type === "snapshot").message)');
  const figure = board.locator('[data-board-card-id="24501"] figure');
  expect(await figure.getAttribute('role')).toBe('presentation');
  expect(await figure.locator('[data-component="AvatarStack"]').isVisible()).toBe(false);
  await board.locator('#gc-collapse').click();
  await expect.poll(() => board.locator('[data-gc-hidden]').count()).toBeGreaterThan(0);
  await board.locator('#gc-menu button').first().click();
  await board.getByRole('menuitem', { name: 'Show log', exact: true }).click();
  await expect.poll(() => worker.evaluate('probe.messages.filter(m => m.type === "watchLog").at(-1)?.watching')).toBe(true);
  await board.evaluate(() => {
    document.documentElement.dataset.testVisibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await preferences(false);
  await shown(board, false);
  expect(await board.locator('#gc-style, #gc-log, .gc-badge, .gc-actor, [data-gc-hidden], [data-gc-actor], [data-gc-issue]').count()).toBe(0);
  expect(await figure.getAttribute('role')).toBe('group');
  expect(await figure.locator('[data-component="AvatarStack"]').isVisible()).toBe(true);
  await expect.poll(() => worker.evaluate('probe.messages.filter(m => m.type === "watchLog").at(-1)?.watching')).toBe(false);
  await worker.evaluate('probe.deliveries = []');
  await emit();
  await worker.evaluate('probe.emit({ type: "log", entries: [{ at: "2026-09-09T12:00:00Z", source: "hub", level: "info", message: "private late log" }] })');
  expect(await worker.evaluate('probe.deliveries.filter(d => ["snapshot", "changed", "log"].includes(d.message.type))')).toEqual([]);
  // Simulate an already queued worker message. Content policy must independently refuse it.
  await worker.evaluate((snapshot) => {
    (globalThis as any).probe.ports[0].postMessage({ type: 'snapshot', snapshot });
  }, reading);
  await board.evaluate(() => {
    document.documentElement.dataset.testVisibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await shown(board, false);
  expect(await board.locator('.gc-badge').count()).toBe(0);
  await preferences(true);
  await shown(board, true);
  await expect.poll(() => board.locator('.gc-badge').count()).toBe(1);
  await worker.evaluate(`
    probe.stale.snapshot.lanes[0].cards[0].issue.avatar.login = 'stale-reviewer';
    probe.ports[0].postMessage(probe.stale);
  `);
  // Wait for a real content event after the queued message, without arbitrary timer delays.
  await navigate(board, BOARD + '/views/1');
  await expect.poll(() => worker.evaluate('probe.reports.at(-1)?.message.pathname')).toBe('/orgs/example-org/projects/3/views/1');
  expect(await board.locator('.gc-actor').getAttribute('aria-label')).toBe('reviewer, pull request author');
});

it('keeps disallowed ports ineligible through content and native reconnects', async () => {
  await preferences(true, [BOARD]);
  const allowed = await pageAt();
  await shown(allowed, true);
  const blocked = await pageAt(OTHER);
  await expect.poll(() => worker.evaluate('probe.ports.length')).toBe(2);
  await worker.evaluate('probe.oldDrop = probe.dropNative; probe.oldEmit = probe.emit; probe.dropNative(); probe.dropContent(1)');
  await expect.poll(() => worker.evaluate('probe.ports.length'), { timeout: 20_000 }).toBe(3);
  await expect.poll(() => worker.evaluate('probe.opens')).toBe(2);
  // Late callbacks from the previous native port must not clear or replace the new connection.
  await worker.evaluate('probe.oldDrop(); probe.oldEmit({ type: "notice", message: "stale native message" })');
  await emit();
  await allowed.locator('#gc-menu button').first().click();
  await allowed.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => worker.evaluate('probe.messages.filter(m => m.type === "refresh").length')).toBe(1);
  expect(await worker.evaluate('probe.deliveries.filter(d => d.message.message === "stale native message")')).toEqual([]);
  await shown(blocked, false);
  expect(await worker.evaluate('probe.deliveries.filter(d => d.id > 0 && ["snapshot", "changed", "log"].includes(d.message.type))')).toEqual([]);
  await navigate(blocked, BOARD);
  await shown(blocked, true);
  await expect.poll(() => blocked.locator('.gc-badge').count()).toBe(1);
});

it('fails closed for invalid stored preferences and can recover through the options page', async () => {
  await worker.evaluate('chrome.storage.local.set({ preferences: { enabled: true, projects: ["https://example.test/"] } })');
  const board = await pageAt();
  await expect.poll(() => worker.evaluate('probe.ports.length')).toBe(1);
  await shown(board, false);
  expect(await worker.evaluate('probe.opens')).toBe(0);
  const settings = await options();
  await expect.poll(() => settings.getByRole('alert').textContent()).toMatch(/invalid|could not|cannot|settings|preferences/i);
  await settings.getByLabel('Enable overlay', { exact: true }).check();
  await settings.getByLabel('Allowed project URLs', { exact: true }).fill(BOARD);
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await shown(board, true);
});

it('discards a cached snapshot read that finishes after preferences disable its requesting tab', async () => {
  await holdCachedSnapshot();
  const board = await pageAt();
  await shown(board, true);
  await expect.poll(() => worker.evaluate('probe.cacheReads')).toBe(1);
  await preferences(false);
  await shown(board, false);
  await expect.poll(() => worker.evaluate('probe.closes')).toBe(1);
  await worker.evaluate('probe.releaseCache()');
  // Round-trip through the worker after promise continuations have run.
  await worker.evaluate('Promise.resolve()');
  expect(await worker.evaluate('probe.deliveries.filter(d => ["snapshot", "changed"].includes(d.message.type))')).toEqual([]);
  expect(await board.locator('.gc-badge').count()).toBe(0);
});

it('keeps a newer native snapshot when an older storage replay finishes later', async () => {
  await holdCachedSnapshot();
  const board = await pageAt();
  await expect.poll(() => worker.evaluate('probe.cacheReads')).toBe(1);
  await emit();
  await expect.poll(() => board.locator('.gc-actor').getAttribute('aria-label')).toBe('reviewer, pull request author');
  await worker.evaluate('probe.releaseCache()');
  await worker.evaluate('Promise.resolve()');
  const second = await pageAt();
  await expect.poll(() => second.locator('.gc-actor').getAttribute('aria-label')).toBe('reviewer, pull request author');
  expect(await board.locator('.gc-actor').getAttribute('aria-label')).toBe('reviewer, pull request author');
  expect(await worker.evaluate('probe.deliveries.filter(d => d.message.type === "snapshot").map(d => d.message.snapshot.lanes[0].cards[0].issue.avatar.login)'))
    .not.toContain('cached-reviewer');
});

it('invalidates an old cache read even when the same tab becomes eligible again', async () => {
  await holdCachedSnapshot();
  const board = await pageAt();
  await expect.poll(() => worker.evaluate('probe.cacheReads')).toBe(1);
  await preferences(false);
  await shown(board, false);
  await expect.poll(() => worker.evaluate('probe.closes')).toBe(1);
  await worker.evaluate(async (snapshot) => {
    await (globalThis as any).chrome.storage.session.set({ last: { type: 'snapshot', snapshot } });
  }, reading);
  await preferences(true);
  await shown(board, true);
  await expect.poll(() => board.locator('.gc-actor').getAttribute('aria-label')).toBe('reviewer, pull request author');
  await worker.evaluate('probe.releaseCache()');
  await worker.evaluate('Promise.resolve()');
  expect(await worker.evaluate('probe.deliveries.filter(d => d.message.type === "snapshot").map(d => d.message.snapshot.lanes[0].cards[0].issue.avatar.login)'))
    .not.toContain('cached-reviewer');
  expect(await board.locator('.gc-actor').getAttribute('aria-label')).toBe('reviewer, pull request author');
});

it('removes all disabled tabs before reporting the new aggregate watching state', async () => {
  const first = await pageAt();
  await shown(first, true);
  const second = await pageAt(OTHER);
  await shown(second, true);
  await expect.poll(() => worker.evaluate('probe.reports.filter(r => r.message.type === "boardState" && r.message.board).length')).toBe(2);
  await worker.evaluate('probe.messages = []');
  await preferences(false);
  await shown(first, false);
  await shown(second, false);
  await expect.poll(() => worker.evaluate('probe.closes')).toBe(1);
  const watching = await worker.evaluate('probe.messages.filter(m => m.type === "watching").map(m => m.watching)');
  expect(watching).toEqual([false]);
});

it('invalidates pending cache work on worker policy changes before content receives those changes', async () => {
  await holdCachedSnapshot();
  const board = await pageAt();
  await expect.poll(() => worker.evaluate('probe.cacheReads')).toBe(1);
  await board.evaluate(() => { document.documentElement.dataset.holdPreferences = 'true'; });
  const before = await worker.evaluate('probe.reports.at(-1).message.token');
  await preferences(false);
  await expect.poll(() => worker.evaluate('probe.closes')).toBe(1);
  await worker.evaluate(async (snapshot) => {
    await (globalThis as any).chrome.storage.session.set({ last: { type: 'snapshot', snapshot } });
  }, reading);
  await preferences(true);
  await expect.poll(() => worker.evaluate('probe.opens')).toBe(2);
  await expect.poll(() => board.locator('.gc-actor').getAttribute('aria-label')).toBe('reviewer, pull request author');
  expect(await worker.evaluate('probe.reports.at(-1).message.token')).toBe(before);
  await worker.evaluate('probe.deliveries = []; probe.releaseCache()');
  await worker.evaluate('Promise.resolve()');
  expect(await worker.evaluate('probe.deliveries.filter(d => d.message.type === "snapshot")')).toEqual([]);
  await board.evaluate(() => {
    document.documentElement.dataset.holdPreferences = 'false';
    document.dispatchEvent(new Event('releasePreferences'));
  });
});
