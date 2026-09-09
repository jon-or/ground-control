import { CHROME_EXTENSION_ID, NATIVE_HOST_NAME, bootstrapDirOf, dirKey, normalize } from '@ground-control/core';

/** Browsers with verified native-messaging registration contracts (mechanics M53). */
export const BROWSERS = ['chrome', 'edge'] as const;
export type Browser = (typeof BROWSERS)[number];

interface BrowserPaths {
  label: string;
  /** Per-user Windows key whose default value names the manifest. */
  registryKey: string;
  /** Per-user manifest directories, relative to home. */
  darwinDir: string;
  linuxDir: string;
}

const BROWSER_PATHS: Record<Browser, BrowserPaths> = {
  chrome: {
    label: 'Google Chrome',
    registryKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    darwinDir: 'Library/Application Support/Google/Chrome/NativeMessagingHosts',
    linuxDir: '.config/google-chrome/NativeMessagingHosts',
  },
  edge: {
    label: 'Microsoft Edge',
    registryKey: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    darwinDir: 'Library/Application Support/Microsoft Edge/NativeMessagingHosts',
    linuxDir: '.config/microsoft-edge/NativeMessagingHosts',
  },
};

/** Read a browser selection from a setting or a comma list; unknown names are reported, not dropped. */
export function parseBrowsers(raw: unknown): { browsers: Browser[]; unknown: string[] } {
  const names = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const browsers: Browser[] = [];
  const unknown: string[] = [];

  for (const name of names) {
    const held = String(name).trim().toLowerCase();

    if (held === '') {
      continue;
    }

    if ((BROWSERS as readonly string[]).includes(held)) {
      if (!browsers.includes(held as Browser)) {
        browsers.push(held as Browser);
      }
    } else {
      unknown.push(String(name).trim());
    }
  }

  return { browsers, unknown };
}

export interface BrowserRegistration {
  browser: Browser;
  label: string;
  manifestPath: string;
  /** Windows locates the manifest through the registry; other platforms use fixed paths. */
  registryKey: string | null;
}

/** Files and registrations for browser native messaging. Explicit commands install and remove these external files (R34). */
export interface ChromeHostPlan {
  manifest: string;
  /** Launcher script; browsers supply no configurable command arguments. */
  wrapperPath: string;
  wrapper: string;
  /** Selected browsers. */
  registrations: BrowserRegistration[];
  /** Supported browsers not selected; owned registrations there are removed on install. */
  others: BrowserRegistration[];
  /** Why this platform cannot register, or null. */
  unsupported: string | null;
}

export interface ChromeHostInput {
  platform: NodeJS.Platform;
  home: string;
  /** Stable hub bundle path retained across extension updates. */
  bundle: string;
  /** Absolute interpreter path; browsers may have a different PATH. */
  node: string;
  extensionId?: string;
  browsers?: readonly Browser[];
}

/** Keep stdout limited to native-message frames. Forward browser arguments with %*. ELECTRON_RUN_AS_NODE lets a VS Code executable run as Node; plain Node ignores it. */
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

/** On Windows every browser reads the one manifest in the bootstrap directory through its own registry key. */
function registrationOf(browser: Browser, platform: NodeJS.Platform, home: string): BrowserRegistration {
  const paths = BROWSER_PATHS[browser];
  const dir =
    platform === 'win32' ? bootstrapDirOf(home) : platform === 'darwin' ? `${home}/${paths.darwinDir}` : `${home}/${paths.linuxDir}`;

  return {
    browser,
    label: paths.label,
    manifestPath: `${dir}/${NATIVE_HOST_NAME}.json`,
    registryKey: platform === 'win32' ? paths.registryKey : null,
  };
}

export function chromeHostPlan(input: ChromeHostInput): ChromeHostPlan {
  const wrapper = wrapperOf(input.platform, input.node, input.bundle);
  const wrapperPath = `${bootstrapDirOf(input.home)}/${wrapper.path}`;
  const selected = input.browsers ?? ['chrome'];
  const supported = input.platform === 'win32' || input.platform === 'darwin' || input.platform === 'linux';

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'Ground Control — the board the GitHub overlay reads.',
    path: wrapperPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${input.extensionId ?? CHROME_EXTENSION_ID}/`],
  };

  return {
    manifest: `${JSON.stringify(manifest, null, 2)}\n`,
    wrapperPath,
    wrapper: wrapper.text,
    registrations: supported ? selected.map((browser) => registrationOf(browser, input.platform, input.home)) : [],
    others: supported ? BROWSERS.filter((browser) => !selected.includes(browser)).map((browser) => registrationOf(browser, input.platform, input.home)) : [],
    unsupported: supported ? null : `Browser registration is not supported on ${input.platform}; Ground Control registers native messaging on Windows, macOS, and Linux.`,
  };
}

export interface ChromeHostDeps {
  write(path: string, text: string, executable: boolean): void;
  remove(path: string): void;
  /** File text, or null when absent or unreadable. */
  read(path: string): string | null;
  /** Invoke reg.exe on Windows and return diagnostic output on failure. */
  registry(args: readonly string[]): string | null;
  /** The manifest path a key registers, or null when the key is absent or unreadable. */
  registered(key: string): string | null;
}

/** Windows paths compare without case; the other platforms' filesystems are case-sensitive. */
function samePath(a: string, b: string, windows: boolean): boolean {
  return windows ? dirKey(a) === dirKey(b) : normalize(a) === normalize(b);
}

/**
 * What a browser's registration currently names: our manifest, another home's, or nothing. Registrations are per
 * user while wrapper and manifest are per home, so only a registration naming this home is ours to remove.
 */
function ownership(plan: ChromeHostPlan, registration: BrowserRegistration, deps: ChromeHostDeps): 'ours' | 'absent' | { theirs: string } {
  if (registration.registryKey !== null) {
    const held = deps.registered(registration.registryKey);

    if (held === null) {
      return 'absent';
    }

    return samePath(held, registration.manifestPath, true) ? 'ours' : { theirs: held };
  }

  const text = deps.read(registration.manifestPath);

  if (text === null) {
    return 'absent';
  }

  try {
    const path = (JSON.parse(text) as { path?: unknown }).path;

    return typeof path === 'string' && samePath(path, plan.wrapperPath, false) ? 'ours' : { theirs: typeof path === 'string' ? path : registration.manifestPath };
  } catch {
    return { theirs: registration.manifestPath };
  }
}

/** Remove one owned registration. Returns the other owner's path when the registration is not ours. */
function unregister(plan: ChromeHostPlan, registration: BrowserRegistration, deps: ChromeHostDeps): string | null {
  const owner = ownership(plan, registration, deps);

  if (typeof owner === 'object') {
    return owner.theirs;
  }

  if (owner === 'ours') {
    if (registration.registryKey !== null) {
      const failed = deps.registry(['delete', registration.registryKey, '/f']);

      if (failed !== null) {
        throw new Error(`Could not remove the ${registration.label} registration: ${failed}`);
      }
    } else {
      deps.remove(registration.manifestPath);
    }
  }

  return null;
}

function labels(registrations: readonly BrowserRegistration[]): string {
  return registrations.map((registration) => registration.label).join(' and ');
}

/** Register the selected browsers and drop owned registrations for the others. Reports the files written outside extension storage (R34). */
export function installChromeHost(plan: ChromeHostPlan, deps: ChromeHostDeps): string {
  if (plan.unsupported !== null) {
    throw new Error(plan.unsupported);
  }

  if (plan.registrations.length === 0) {
    throw new Error('No browser is selected; choose at least one in groundControl.overlayBrowsers.');
  }

  deps.write(plan.wrapperPath, plan.wrapper, true);

  for (const path of new Set(plan.registrations.map((registration) => registration.manifestPath))) {
    deps.write(path, plan.manifest, false);
  }

  for (const registration of plan.registrations) {
    if (registration.registryKey !== null) {
      const failed = deps.registry(['add', registration.registryKey, '/ve', '/t', 'REG_SZ', '/d', registration.manifestPath, '/f']);

      if (failed !== null) {
        throw new Error(`Could not register the ${registration.label} bridge: ${failed}`);
      }
    }
  }

  const dropped = plan.others.filter((registration) => ownership(plan, registration, deps) === 'ours');

  for (const registration of dropped) {
    unregister(plan, registration, deps);
  }

  const removal = dropped.length > 0 ? ` Removed the ${labels(dropped)} registration.` : '';

  return `GitHub overlay connection enabled for ${labels(plan.registrations)}. Launcher: ${plan.wrapperPath}.${removal}`;
}

/**
 * Remove the selected registrations Ground Control owns. The wrapper and the shared Windows manifest stay while an
 * unselected browser still holds our registration; a plan selecting every browser removes everything.
 */
export function uninstallChromeHost(plan: ChromeHostPlan, deps: ChromeHostDeps): string {
  const kept: string[] = [];

  for (const registration of plan.registrations) {
    const theirs = unregister(plan, registration, deps);

    if (theirs !== null) {
      kept.push(`${registration.label} remains registered to ${theirs}.`);
    }
  }

  const still = plan.others.filter((registration) => ownership(plan, registration, deps) === 'ours');

  if (still.length > 0) {
    return [`GitHub overlay connection disabled for ${labels(plan.registrations)}; ${labels(still)} keeps the launcher.`, ...kept].join(' ');
  }

  // On Windows the manifest is shared and no registration of ours remains; on other platforms unregister removed ours.
  for (const path of new Set(plan.registrations.filter((registration) => registration.registryKey !== null).map((registration) => registration.manifestPath))) {
    deps.remove(path);
  }

  deps.remove(plan.wrapperPath);

  return [`GitHub overlay connection disabled${plan.registrations.length === BROWSERS.length ? '' : ` for ${labels(plan.registrations)}`}.`, ...kept].join(' ');
}
