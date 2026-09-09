import { describe, expect, it } from 'vitest';
import { CHROME_EXTENSION_ID, NATIVE_HOST_NAME } from '@ground-control/core';
import { BROWSERS, chromeHostPlan, installChromeHost, parseBrowsers, uninstallChromeHost } from '../src/chromeHost.js';
import type { Browser, ChromeHostDeps, ChromeHostPlan } from '../src/chromeHost.js';

const HOME = 'd:/home/dev';

function plan(platform: NodeJS.Platform, browsers?: readonly Browser[]): ChromeHostPlan {
  return chromeHostPlan({
    platform,
    home: HOME,
    bundle: `${HOME}/.claude/ground-control/hub.js`,
    node: 'd:/node/node.exe',
    ...(browsers === undefined ? {} : { browsers }),
  });
}

/** Registry values by key and file text by path stand in for the real per-user state. */
function fakeDeps(state: { registry?: Record<string, string>; files?: Record<string, string>; addFails?: string } = {}) {
  const wrote: { path: string; text: string; executable: boolean }[] = [];
  const removed: string[] = [];
  const ran: string[][] = [];
  const registry = { ...(state.registry ?? {}) };
  const files = { ...(state.files ?? {}) };

  const deps: ChromeHostDeps = {
    write: (path, text, executable) => {
      wrote.push({ path, text, executable });
      files[path] = text;
    },
    remove: (path) => {
      removed.push(path);
      delete files[path];
    },
    read: (path) => files[path] ?? null,
    registry: (args) => {
      ran.push([...args]);

      if (args[0] === 'add') {
        if (state.addFails !== undefined) {
          return state.addFails;
        }

        registry[args[1]!] = args[6]!;
      }

      if (args[0] === 'delete') {
        delete registry[args[1]!];
      }

      return null;
    },
    registered: (key) => registry[key] ?? null,
  };

  return { deps, wrote, removed, ran, registry, files };
}

describe('where browsers look for the bridge', () => {
  it('names the manifest by the name the browser looks it up by', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const registration of plan(platform, BROWSERS).registrations) {
        expect(registration.manifestPath.endsWith(`/${NATIVE_HOST_NAME}.json`)).toBe(true);
      }
    }
  });

  /** Paths from the Chrome and Edge native-messaging documentation (M53), not derived from one another. */
  it('puts each browser manifest where that browser reads it', () => {
    const [chrome, edge] = plan('darwin', BROWSERS).registrations;

    expect(chrome?.manifestPath).toBe(`${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`);
    expect(edge?.manifestPath).toBe(`${HOME}/Library/Application Support/Microsoft Edge/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`);

    const [chromeLinux, edgeLinux] = plan('linux', BROWSERS).registrations;

    expect(chromeLinux?.manifestPath).toBe(`${HOME}/.config/google-chrome/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`);
    expect(edgeLinux?.manifestPath).toBe(`${HOME}/.config/microsoft-edge/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`);
  });

  /** Windows finds the manifest through the registry, so both browsers share the one beside everything else the hub writes. */
  it('registers per user, never for the whole machine, and shares one manifest on Windows', () => {
    const [chrome, edge] = plan('win32', BROWSERS).registrations;

    expect(chrome?.registryKey).toBe(`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`);
    expect(edge?.registryKey).toBe(`HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`);
    expect(chrome?.manifestPath).toBe(`${HOME}/.claude/ground-control/${NATIVE_HOST_NAME}.json`);
    expect(edge?.manifestPath).toBe(chrome?.manifestPath);
    expect(plan('darwin', BROWSERS).registrations.every((registration) => registration.registryKey === null)).toBe(true);
  });

  it('selects Chrome alone by default and keeps the other browser in reach for removal', () => {
    const held = plan('win32');

    expect(held.registrations.map((registration) => registration.browser)).toEqual(['chrome']);
    expect(held.others.map((registration) => registration.browser)).toEqual(['edge']);
  });

  it('allows only the configured extension, whose unpacked ID is the same in both browsers', () => {
    const manifest = JSON.parse(plan('win32').manifest) as { allowed_origins: string[]; path: string; type: string };

    expect(manifest.allowed_origins).toEqual([`chrome-extension://${CHROME_EXTENSION_ID}/`]);
    expect(manifest.type).toBe('stdio');
    expect(manifest.path).toBe(plan('win32').wrapperPath);
  });

  /** The browser reads this process's stdout as message frames, so a line the wrapper prints is a malformed frame. */
  it('keeps launcher stdout limited to native-message frames', () => {
    const windows = plan('win32');

    expect(windows.wrapperPath).toBe(`${HOME}/.claude/ground-control/ground-control-bridge.cmd`);
    expect(windows.wrapper.startsWith('@echo off')).toBe(true);
    expect(windows.wrapper).toContain('"d:/node/node.exe" "d:/home/dev/.claude/ground-control/hub.js" --native-messaging');

    const posix = plan('linux');

    expect(posix.wrapperPath).toBe(`${HOME}/.claude/ground-control/ground-control-bridge.sh`);
    expect(posix.wrapper.startsWith('#!/bin/sh')).toBe(true);
    expect(posix.wrapper).toContain('--native-messaging');
  });

  /** Use the stable hub bundle path across extension updates. */
  it('names the one hub every client starts', () => {
    expect(plan('win32').wrapper).toContain('/.claude/ground-control/hub.js');
  });

  /** The interpreter may be VS Code's executable; ELECTRON_RUN_AS_NODE prevents opening an editor instead of the bridge. */
  it('sets ELECTRON_RUN_AS_NODE for the launcher', () => {
    expect(plan('win32').wrapper).toContain('set ELECTRON_RUN_AS_NODE=1');
    expect(plan('linux').wrapper).toContain('ELECTRON_RUN_AS_NODE=1 exec');
  });

  it('names the platforms it cannot register on instead of guessing a path', () => {
    const held = plan('freebsd', BROWSERS);

    expect(held.unsupported).toContain('not supported on freebsd');
    expect(held.registrations).toEqual([]);
    expect(() => installChromeHost(held, fakeDeps().deps)).toThrow(/not supported on freebsd/);
  });
});

describe('reading a browser selection', () => {
  it('accepts arrays and comma lists, ignoring case, spaces, repeats and blanks', () => {
    expect(parseBrowsers(['Chrome', ' edge ', 'chrome'])).toEqual({ browsers: ['chrome', 'edge'], unknown: [] });
    expect(parseBrowsers('edge, ,chrome')).toEqual({ browsers: ['edge', 'chrome'], unknown: [] });
    expect(parseBrowsers(undefined)).toEqual({ browsers: [], unknown: [] });
  });

  it('reports names it has no registration for rather than dropping them', () => {
    expect(parseBrowsers('chrome,brave')).toEqual({ browsers: ['chrome'], unknown: ['brave'] });
  });
});

describe('registering and unregistering', () => {
  it('writes the wrapper executable and the manifest beside it, then points the browser at it', () => {
    const { deps, wrote, ran } = fakeDeps();
    const windows = plan('win32');
    const said = installChromeHost(windows, deps);
    const [chrome] = windows.registrations;

    expect(wrote).toEqual([
      { path: windows.wrapperPath, text: windows.wrapper, executable: true },
      { path: chrome!.manifestPath, text: windows.manifest, executable: false },
    ]);
    expect(ran).toEqual([['add', chrome!.registryKey, '/ve', '/t', 'REG_SZ', '/d', chrome!.manifestPath, '/f']]);
    expect(said).toContain('enabled for Google Chrome.');
    expect(said).toContain(windows.wrapperPath);
  });

  it('registers both browsers against the one Windows manifest', () => {
    const { deps, wrote, ran } = fakeDeps();
    const said = installChromeHost(plan('win32', BROWSERS), deps);

    expect(wrote.filter((entry) => !entry.executable)).toHaveLength(1);
    expect(ran.map((args) => args[1])).toEqual(plan('win32', BROWSERS).registrations.map((registration) => registration.registryKey));
    expect(said).toContain('enabled for Google Chrome and Microsoft Edge.');
  });

  it('writes a manifest into each browser directory on a platform that has none', () => {
    const { deps, wrote, ran } = fakeDeps();

    installChromeHost(plan('darwin', BROWSERS), deps);

    expect(wrote.filter((entry) => !entry.executable).map((entry) => entry.path)).toEqual(
      plan('darwin', BROWSERS).registrations.map((registration) => registration.manifestPath),
    );
    expect(ran).toEqual([]);
  });

  /** A registration that half happened is worse than none: the developer is told, rather than left to find out. */
  it('reports a registry that would not take the value', () => {
    const { deps } = fakeDeps({ addFails: 'Access is denied.' });

    expect(() => installChromeHost(plan('win32'), deps)).toThrow(/Access is denied/);
  });

  it('refuses an empty selection instead of registering nothing and calling it enabled', () => {
    expect(() => installChromeHost(plan('win32', []), fakeDeps().deps)).toThrow(/overlayBrowsers/);
  });

  /** Enabling with a narrower selection is how a browser is deselected; its registration must not linger. */
  it('drops the registration of a browser no longer selected, keeping the shared wrapper', () => {
    const both = plan('win32', BROWSERS);
    const { deps, ran, removed, registry } = fakeDeps({
      registry: Object.fromEntries(both.registrations.map((registration) => [registration.registryKey!, registration.manifestPath])),
    });

    const said = installChromeHost(plan('win32', ['chrome']), deps);

    expect(ran).toContainEqual(['delete', both.registrations[1]!.registryKey, '/f']);
    expect(Object.keys(registry)).toEqual([both.registrations[0]!.registryKey]);
    expect(removed).toEqual([]);
    expect(said).toContain('Removed the Microsoft Edge registration.');
  });

  it('leaves a deselected browser alone when its registration belongs to another home', () => {
    const [, edge] = plan('win32', BROWSERS).registrations;
    const { deps, ran, registry } = fakeDeps({ registry: { [edge!.registryKey!]: 'c:/users/other/.claude/ground-control/manifest.json' } });

    const said = installChromeHost(plan('win32', ['chrome']), deps);

    expect(ran.filter((args) => args[0] === 'delete')).toEqual([]);
    expect(registry[edge!.registryKey!]).toBe('c:/users/other/.claude/ground-control/manifest.json');
    expect(said).not.toContain('Removed');
  });

  it('removes every registration it owns, the manifest and the wrapper when every browser is selected', () => {
    const both = plan('win32', BROWSERS);
    const { deps, removed, ran } = fakeDeps({
      registry: Object.fromEntries(both.registrations.map((registration) => [registration.registryKey!, registration.manifestPath])),
    });

    expect(uninstallChromeHost(both, deps)).toBe('GitHub overlay connection disabled.');
    expect(ran).toEqual(both.registrations.map((registration) => ['delete', registration.registryKey, '/f']));
    expect(removed).toEqual([both.registrations[0]!.manifestPath, both.wrapperPath]);
  });

  /** Disabling one browser must not take the launcher away from the other. */
  it('disables only the selected browser and keeps the launcher and manifest the other still needs', () => {
    const both = plan('win32', BROWSERS);
    const { deps, removed, ran, registry } = fakeDeps({
      registry: Object.fromEntries(both.registrations.map((registration) => [registration.registryKey!, registration.manifestPath])),
    });

    const said = uninstallChromeHost(plan('win32', ['chrome']), deps);

    expect(ran).toEqual([['delete', both.registrations[0]!.registryKey, '/f']]);
    expect(Object.keys(registry)).toEqual([both.registrations[1]!.registryKey]);
    expect(removed).toEqual([]);
    expect(said).toBe('GitHub overlay connection disabled for Google Chrome; Microsoft Edge keeps the launcher.');
  });

  it('reports a registration the registry would not release instead of removing the files under it', () => {
    const windows = plan('win32');
    const [chrome] = windows.registrations;
    const { deps, removed } = fakeDeps({ registry: { [chrome!.registryKey!]: chrome!.manifestPath } });
    const failing: ChromeHostDeps = { ...deps, registry: (args) => (args[0] === 'delete' ? 'Access is denied.' : deps.registry(args)) };

    expect(() => uninstallChromeHost(windows, failing)).toThrow(/Could not remove the Google Chrome registration: Access is denied/);
    expect(removed).toEqual([]);
  });

  /** Linux and macOS paths are case-sensitive; a differently cased home is a different home. */
  it('does not mistake a differently cased POSIX home for its own', () => {
    const linux = plan('linux');
    const [chrome] = linux.registrations;
    const { deps, removed } = fakeDeps({ files: { [chrome!.manifestPath]: JSON.stringify({ path: linux.wrapperPath.toUpperCase() }) } });

    const said = uninstallChromeHost(linux, deps);

    expect(removed).toEqual([linux.wrapperPath]);
    expect(said).toContain(`Google Chrome remains registered to ${linux.wrapperPath.toUpperCase()}.`);
  });

  it('removes only the manifests it wrote on a platform without a registry', () => {
    const both = plan('linux', BROWSERS);
    const ours = both.manifest;
    const theirs = JSON.stringify({ path: '/home/other/.claude/ground-control/ground-control-bridge.sh' });
    const { deps, removed } = fakeDeps({
      files: { [both.registrations[0]!.manifestPath]: ours, [both.registrations[1]!.manifestPath]: theirs },
    });

    const said = uninstallChromeHost(both, deps);

    expect(removed).toEqual([both.registrations[0]!.manifestPath, both.wrapperPath]);
    expect(said).toContain('Microsoft Edge remains registered to /home/other/.claude/ground-control/ground-control-bridge.sh.');
  });

  /** Removing a registration nobody made is the wanted state, not a failure to report. */
  it('accepts removal of absent registration', () => {
    const { deps, removed, ran } = fakeDeps();

    expect(uninstallChromeHost(plan('win32'), deps)).toBe('GitHub overlay connection disabled for Google Chrome.');
    expect(ran).toEqual([]);
    expect(removed).toHaveLength(2);
  });

  it('matches the registered manifest across separator and case differences', () => {
    const windows = plan('win32');
    const [chrome] = windows.registrations;
    const { deps, ran } = fakeDeps({ registry: { [chrome!.registryKey!]: chrome!.manifestPath.toUpperCase().replace(/\//g, '\\') } });

    uninstallChromeHost(windows, deps);

    expect(ran).toEqual([['delete', chrome!.registryKey, '/f']]);
  });

  /** One user, many homes: a test or a second install must not unregister the browser from the home in use. */
  it('leaves a registration that names another home in place and says so', () => {
    const windows = plan('win32');
    const [chrome] = windows.registrations;
    const other = 'c:/users/dev/.claude/ground-control/com.groundcontrol.ground_control.json';
    const { deps, removed, ran } = fakeDeps({ registry: { [chrome!.registryKey!]: other } });

    expect(uninstallChromeHost(windows, deps)).toContain(`Google Chrome remains registered to ${other}.`);
    expect(ran).toEqual([]);
    expect(removed).toEqual([chrome!.manifestPath, windows.wrapperPath]);
  });
});
