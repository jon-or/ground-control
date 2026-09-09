// @ts-check
/** Browser-local policy; shared hub settings remain in VS Code. */
export const PREFERENCES_KEY = 'preferences';

/** @typedef {{ enabled: boolean, projects: string[], animations: boolean, replaceAvatars: boolean }} Preferences */
/** @typedef {{ value: Preferences | null, error: string | null }} PreferenceState */

/** Exact project identity, excluding view selection. @param {string} pathname */
export function projectPath(pathname) {
  const match = /^\/(orgs|users)\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/projects\/([1-9]\d*)(?:\/views\/[1-9]\d*)?\/?$/i.exec(pathname);
  const [, kind, owner, number] = match ?? [];
  return kind && owner && number ? `/${kind.toLowerCase()}/${owner.toLowerCase()}/projects/${number}` : null;
}

/** Accept only HTTPS GitHub project URLs, without credentials. @param {unknown} raw */
export function projectUrl(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw.trim());
    if (url.origin !== 'https://github.com' || url.username || url.password) return null;
    // Inspect the original path too: URL parsing normalizes dot segments and backslashes.
    const rawPath = /^https:\/\/github\.com(?::443)?(\/[^?#]*)(?:[?#].*)?$/i.exec(raw.trim())?.[1];
    const path = rawPath === undefined ? null : projectPath(rawPath);
    return path === null ? null : `https://github.com${path}`;
  } catch {
    return null;
  }
}

/** Invalid durable data closes access until corrected in options. @param {unknown} raw @returns {PreferenceState} */
export function parsePreferences(raw) {
  if (raw === undefined) return { value: { enabled: true, projects: [], animations: true, replaceAvatars: true }, error: null };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const held = /** @type {Record<string, unknown>} */ (raw);
  if (typeof held.enabled !== 'boolean' || !Array.isArray(held.projects)) return invalid();
  // Presentation keys arrived later; a stored object without them keeps the defaults, a wrong type is invalid.
  const animations = held.animations === undefined ? true : held.animations;
  const replaceAvatars = held.replaceAvatars === undefined ? true : held.replaceAvatars;
  if (typeof animations !== 'boolean' || typeof replaceAvatars !== 'boolean') return invalid();
  const projects = held.projects.map(projectUrl);
  if (projects.some((project) => project === null)) return invalid();
  return { value: { enabled: held.enabled, projects: [...new Set(/** @type {string[]} */ (projects))], animations, replaceAvatars }, error: null };
}

/** @typedef {{ animations: boolean, replaceAvatars: boolean }} Presentation */

/** What the overlay draws with; invalid or unread preferences fall back to the defaults, access is refused separately.
 * @param {Preferences | null} preferences @returns {Presentation} */
export function presentationOf(preferences) {
  return { animations: preferences?.animations ?? true, replaceAvatars: preferences?.replaceAvatars ?? true };
}

/** @returns {PreferenceState} */
function invalid() {
  return { value: null, error: 'Overlay preferences are invalid. Save valid preferences here to restore access.' };
}

/** @param {Preferences | null} preferences @param {string} pathname */
export function allowsProject(preferences, pathname) {
  const path = projectPath(pathname);
  return preferences !== null && preferences.enabled && path !== null &&
    (preferences.projects.length === 0 || preferences.projects.includes(`https://github.com${path}`));
}

/** Register updates before reading so a slow initial read cannot replace a newer choice.
 * @param {typeof chrome.storage} storage
 * @param {(state: PreferenceState) => void} changed
 */
export function watchPreferences(storage, changed) {
  let revision = 0;
  let active = true;
  /** @param {Record<string, chrome.storage.StorageChange>} changes @param {string} area */
  const listener = (changes, area) => {
    if (!active || area !== 'local' || !Object.hasOwn(changes, PREFERENCES_KEY)) return;
    revision++;
    changed(parsePreferences(changes[PREFERENCES_KEY]?.newValue));
  };
  storage.onChanged.addListener(listener);
  const started = revision;
  void (async () => storage.local.get(PREFERENCES_KEY))().then((held) => {
    if (active && started === revision) changed(parsePreferences(held[PREFERENCES_KEY]));
  }, () => {
    if (active && started === revision) changed({ value: null, error: 'Could not read overlay preferences. Reload this page or save your preferences again.' });
  });
  return () => { active = false; storage.onChanged.removeListener(listener); };
}
