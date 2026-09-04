import { CHROME_EXTENSION_ID, NATIVE_HOST_NAME, groundControlDirOf } from '@ground-control/core';

/**
 * What Chrome must find on disk before the overlay can reach the hub, and where. Registration is a deliberate act
 * (R34): it writes outside the extension's own storage, so a command asks for it and the same command undoes it.
 */
export interface ChromeHostPlan {
  /** The native-messaging manifest Chrome reads to learn what to start. */
  manifestPath: string;
  manifest: string;
  /** What Chrome actually starts. A script, because Chrome runs one command with no arguments of its own. */
  wrapperPath: string;
  wrapper: string;
  /** Windows finds the manifest through this key. Every other platform finds it by its path alone. */
  registryKey: string | null;
}

export interface ChromeHostInput {
  platform: NodeJS.Platform;
  home: string;
  /** The hub bundle every client starts, so an extension update never orphans what this manifest names. */
  bundle: string;
  /** The interpreter that ran the install. The wrapper names it outright: Chrome's PATH is not the developer's. */
  node: string;
  extensionId?: string;
}

const REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;

/**
 * Where Chrome looks for a per-user host manifest. On Windows it looks nowhere: the registry value carries the
 * path, so the manifest lives beside everything else the hub writes.
 */
function manifestDirOf(platform: NodeJS.Platform, home: string): string {
  if (platform === 'darwin') {
    return `${home}/Library/Application Support/Google/Chrome/NativeMessagingHosts`;
  }

  return platform === 'win32' ? groundControlDirOf(home) : `${home}/.config/google-chrome/NativeMessagingHosts`;
}

/**
 * `@echo off` and no output of its own: Chrome reads this process's stdout as message frames, so a line printed by
 * the wrapper is a malformed frame and the port closes. `%*` carries the origin Chrome passes on the command line.
 *
 * `ELECTRON_RUN_AS_NODE` because the interpreter that ran the install may be VS Code's own executable, which opens
 * an editor unless it is told to be node. Plain node ignores it, so the wrapper does not have to know which it has.
 */
function wrapperOf(platform: NodeJS.Platform, node: string, bundle: string): { path: string; text: string } {
  if (platform === 'win32') {
    return {
      path: 'ground-control-bridge.cmd',
      text: `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${node}" "${bundle}" --native-messaging %*\r\n`,
    };
  }

  return {
    path: 'ground-control-bridge.sh',
    text: `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${node}" "${bundle}" --native-messaging "$@"\n`,
  };
}

export function chromeHostPlan(input: ChromeHostInput): ChromeHostPlan {
  const wrapper = wrapperOf(input.platform, input.node, input.bundle);
  const wrapperPath = `${groundControlDirOf(input.home)}/${wrapper.path}`;

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'Ground Control — the board the GitHub overlay reads.',
    path: wrapperPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${input.extensionId ?? CHROME_EXTENSION_ID}/`],
  };

  return {
    manifestPath: `${manifestDirOf(input.platform, input.home)}/${NATIVE_HOST_NAME}.json`,
    manifest: `${JSON.stringify(manifest, null, 2)}\n`,
    wrapperPath,
    wrapper: wrapper.text,
    registryKey: input.platform === 'win32' ? REGISTRY_KEY : null,
  };
}

export interface ChromeHostDeps {
  write(path: string, text: string, executable: boolean): void;
  remove(path: string): void;
  /** `reg.exe`, on the one platform that needs it. Returns what it said, so a failure is reported rather than assumed. */
  registry(args: readonly string[]): string | null;
}

/** What was done, in the developer's terms — a command that writes outside its own storage says what it wrote (R34). */
export function installChromeHost(plan: ChromeHostPlan, deps: ChromeHostDeps): string {
  deps.write(plan.wrapperPath, plan.wrapper, true);
  deps.write(plan.manifestPath, plan.manifest, false);

  if (plan.registryKey !== null) {
    const failed = deps.registry(['add', plan.registryKey, '/ve', '/t', 'REG_SZ', '/d', plan.manifestPath, '/f']);

    if (failed !== null) {
      throw new Error(`Chrome could not be told where the bridge is: ${failed}`);
    }
  }

  return `The GitHub overlay can now reach the board. Chrome starts ${plan.wrapperPath}.`;
}

export function uninstallChromeHost(plan: ChromeHostPlan, deps: ChromeHostDeps): string {
  if (plan.registryKey !== null) {
    // Not an error: a registration that was never made, or was made and then removed by hand, is the wanted state.
    deps.registry(['delete', plan.registryKey, '/f']);
  }

  deps.remove(plan.manifestPath);
  deps.remove(plan.wrapperPath);

  return 'The GitHub overlay can no longer reach the board.';
}
