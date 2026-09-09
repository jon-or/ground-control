import { CHROME_EXTENSION_ID, NATIVE_HOST_NAME, bootstrapDirOf } from '@ground-control/core';

/** Files and registration required for Chrome native messaging. Explicit commands install and remove these external files (R34). */
export interface ChromeHostPlan {
  /** Chrome native-messaging manifest. */
  manifestPath: string;
  manifest: string;
  /** Launcher script; Chrome supplies no configurable command arguments. */
  wrapperPath: string;
  wrapper: string;
  /** Windows registry key locating the manifest; other platforms use fixed paths. */
  registryKey: string | null;
}

export interface ChromeHostInput {
  platform: NodeJS.Platform;
  home: string;
  /** Stable hub bundle path retained across extension updates. */
  bundle: string;
  /** Absolute interpreter path; Chrome may have a different PATH. */
  node: string;
  extensionId?: string;
}

const REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;

/** Per-user manifest location in the fixed bootstrap directory on Windows, which reads its path from the registry. */
function manifestDirOf(platform: NodeJS.Platform, home: string): string {
  if (platform === 'darwin') {
    return `${home}/Library/Application Support/Google/Chrome/NativeMessagingHosts`;
  }

  return platform === 'win32' ? bootstrapDirOf(home) : `${home}/.config/google-chrome/NativeMessagingHosts`;
}

/** Keep stdout limited to native-message frames. Forward Chrome arguments with %*. ELECTRON_RUN_AS_NODE lets a VS Code executable run as Node; plain Node ignores it. */
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
  const wrapperPath = `${bootstrapDirOf(input.home)}/${wrapper.path}`;

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
  /** Invoke reg.exe on Windows and return diagnostic output on failure. */
  registry(args: readonly string[]): string | null;
}

/** Report the files and registration written outside extension storage (R34). */
export function installChromeHost(plan: ChromeHostPlan, deps: ChromeHostDeps): string {
  deps.write(plan.wrapperPath, plan.wrapper, true);
  deps.write(plan.manifestPath, plan.manifest, false);

  if (plan.registryKey !== null) {
    const failed = deps.registry(['add', plan.registryKey, '/ve', '/t', 'REG_SZ', '/d', plan.manifestPath, '/f']);

    if (failed !== null) {
      throw new Error(`Could not register the Chrome bridge: ${failed}`);
    }
  }

  return `GitHub overlay connection enabled. Chrome launcher: ${plan.wrapperPath}.`;
}

export function uninstallChromeHost(plan: ChromeHostPlan, deps: ChromeHostDeps): string {
  if (plan.registryKey !== null) {
    // Missing registration already satisfies uninstall.
    deps.registry(['delete', plan.registryKey, '/f']);
  }

  deps.remove(plan.manifestPath);
  deps.remove(plan.wrapperPath);

  return 'GitHub overlay connection disabled.';
}
