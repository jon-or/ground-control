import { describe, expect, it } from 'vitest';
import { CHROME_EXTENSION_ID, NATIVE_HOST_NAME } from '@ground-control/core';
import { chromeHostPlan, installChromeHost, uninstallChromeHost } from '../src/chromeHost.js';
import type { ChromeHostDeps, ChromeHostPlan } from '../src/chromeHost.js';

const HOME = 'd:/home/dev';

function plan(platform: NodeJS.Platform): ChromeHostPlan {
  return chromeHostPlan({ platform, home: HOME, bundle: `${HOME}/.claude/ground-control/hub.js`, node: 'd:/node/node.exe' });
}

function fakeDeps(registry: string | null = null) {
  const wrote: { path: string; text: string; executable: boolean }[] = [];
  const removed: string[] = [];
  const ran: string[][] = [];

  const deps: ChromeHostDeps = {
    write: (path, text, executable) => wrote.push({ path, text, executable }),
    remove: (path) => removed.push(path),
    registry: (args) => {
      ran.push([...args]);

      return registry;
    },
  };

  return { deps, wrote, removed, ran };
}

describe('where Chrome looks for the bridge', () => {
  it('names the manifest by the name Chrome looks it up by', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(plan(platform).manifestPath.endsWith(`/${NATIVE_HOST_NAME}.json`)).toBe(true);
    }
  });

  it('puts the manifest where each platform reads it', () => {
    expect(plan('darwin').manifestPath).toBe(
      `${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`,
    );
    expect(plan('linux').manifestPath).toBe(
      `${HOME}/.config/google-chrome/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`,
    );
    // Windows finds it through the registry instead, so it lives beside everything else the hub writes.
    expect(plan('win32').manifestPath).toBe(`${HOME}/.claude/ground-control/${NATIVE_HOST_NAME}.json`);
  });

  it('registers per user, never for the whole machine', () => {
    expect(plan('win32').registryKey).toBe(
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    );
    expect(plan('darwin').registryKey).toBeNull();
    expect(plan('linux').registryKey).toBeNull();
  });

  it('lets in this extension and nothing else', () => {
    const manifest = JSON.parse(plan('win32').manifest) as { allowed_origins: string[]; path: string; type: string };

    expect(manifest.allowed_origins).toEqual([`chrome-extension://${CHROME_EXTENSION_ID}/`]);
    expect(manifest.type).toBe('stdio');
    expect(manifest.path).toBe(plan('win32').wrapperPath);
  });

  /** Chrome reads this process's stdout as message frames, so a line the wrapper prints is a malformed frame. */
  it('starts the bridge from a wrapper that prints nothing of its own', () => {
    const windows = plan('win32');

    expect(windows.wrapperPath).toBe(`${HOME}/.claude/ground-control/ground-control-bridge.cmd`);
    expect(windows.wrapper.startsWith('@echo off')).toBe(true);
    expect(windows.wrapper).toContain('"d:/node/node.exe" "d:/home/dev/.claude/ground-control/hub.js" --native-messaging');

    const posix = plan('linux');

    expect(posix.wrapperPath).toBe(`${HOME}/.claude/ground-control/ground-control-bridge.sh`);
    expect(posix.wrapper.startsWith('#!/bin/sh')).toBe(true);
    expect(posix.wrapper).toContain('--native-messaging');
  });

  /** The bundle path, never the extension's own copy: an update would otherwise orphan what this manifest names. */
  it('names the one hub every client starts', () => {
    expect(plan('win32').wrapper).toContain('/.claude/ground-control/hub.js');
  });

  /**
   * The command that registered this may have run inside VS Code, whose executable is the interpreter written into
   * the wrapper. Without this, Chrome starts an editor instead of a bridge and the port closes with no message.
   */
  it('tells an Electron interpreter to be node', () => {
    expect(plan('win32').wrapper).toContain('set ELECTRON_RUN_AS_NODE=1');
    expect(plan('linux').wrapper).toContain('ELECTRON_RUN_AS_NODE=1 exec');
  });
});

describe('registering and unregistering', () => {
  it('writes the wrapper executable and the manifest beside it, then points Chrome at it', () => {
    const { deps, wrote, ran } = fakeDeps();
    const windows = plan('win32');
    const said = installChromeHost(windows, deps);

    expect(wrote).toEqual([
      { path: windows.wrapperPath, text: windows.wrapper, executable: true },
      { path: windows.manifestPath, text: windows.manifest, executable: false },
    ]);
    expect(ran).toEqual([['add', windows.registryKey, '/ve', '/t', 'REG_SZ', '/d', windows.manifestPath, '/f']]);
    expect(said).toContain(windows.wrapperPath);
  });

  it('touches no registry on a platform that has none', () => {
    const { deps, wrote, ran } = fakeDeps();

    installChromeHost(plan('darwin'), deps);

    expect(wrote).toHaveLength(2);
    expect(ran).toEqual([]);
  });

  /** A registration that half happened is worse than none: the developer is told, rather than left to find out. */
  it('reports a registry that would not take the value', () => {
    const { deps } = fakeDeps('Access is denied.');

    expect(() => installChromeHost(plan('win32'), deps)).toThrow(/Access is denied/);
  });

  it('removes the key, the manifest and the wrapper', () => {
    const { deps, removed, ran } = fakeDeps();
    const windows = plan('win32');

    uninstallChromeHost(windows, deps);

    expect(ran).toEqual([['delete', windows.registryKey, '/f']]);
    expect(removed).toEqual([windows.manifestPath, windows.wrapperPath]);
  });

  /** Removing a registration nobody made is the wanted state, not a failure to report. */
  it('does not complain when there was nothing registered', () => {
    const { deps, removed } = fakeDeps('The system was unable to find the specified registry key.');

    expect(() => uninstallChromeHost(plan('win32'), deps)).not.toThrow();
    expect(removed).toHaveLength(2);
  });
});
