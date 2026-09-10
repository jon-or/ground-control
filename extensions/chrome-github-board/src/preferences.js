// @ts-check
/** Browser-local policy; shared hub settings remain in VS Code. */
export const PREFERENCES_KEY = 'preferences';

/** Assignee logins the hub last reported, cached so the filter gate survives a reload with no connection. */
export const LOGINS_KEY = 'logins';

/** @typedef {{ enabled: boolean, projects: string[], animations: boolean, replaceAvatars: boolean, filteredToMe: boolean }} Preferences */
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
  if (raw === undefined) return { value: { enabled: true, projects: [], animations: true, replaceAvatars: true, filteredToMe: true }, error: null };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const held = /** @type {Record<string, unknown>} */ (raw);
  if (typeof held.enabled !== 'boolean' || !Array.isArray(held.projects)) return invalid();
  // These keys arrived after the first release; a stored object without them keeps the defaults, a wrong type is invalid.
  const animations = held.animations === undefined ? true : held.animations;
  const replaceAvatars = held.replaceAvatars === undefined ? true : held.replaceAvatars;
  const filteredToMe = held.filteredToMe === undefined ? true : held.filteredToMe;
  if (typeof animations !== 'boolean' || typeof replaceAvatars !== 'boolean' || typeof filteredToMe !== 'boolean') return invalid();
  const projects = held.projects.map(projectUrl);
  if (projects.some((project) => project === null)) return invalid();
  return { value: { enabled: held.enabled, projects: [...new Set(/** @type {string[]} */ (projects))], animations, replaceAvatars, filteredToMe }, error: null };
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

/** A whole assignee qualifier, keeping quoted and comma-joined values together. A leading `-` negates it, so it does not match. */
const ASSIGNEE = /(?:^|\s)assignee:((?:"[^"]*"|[^\s"])+)/gi;

/**
 * True when a board's filter restricts it to the developer: at least one assignee qualifier, every value naming
 * `@me` or a known login (R36). Negated qualifiers only narrow a board, so they are ignored rather than refused.
 *
 * @param {string | null} filter @param {readonly string[]} logins
 */
export function filtersToMe(filter, logins) {
  if (typeof filter !== 'string') return false;

  const known = new Set(logins.map((login) => login.toLowerCase()));
  let matched = false;

  for (const [, raw] of filter.matchAll(ASSIGNEE)) {
    const values = (raw ?? '').split(',').map((value) => value.replace(/"/g, '').trim().toLowerCase()).filter(Boolean);
    if (values.length === 0 || !values.every((value) => value === '@me' || known.has(value))) return false;
    matched = true;
  }

  return matched;
}

/** Read the logins the worker cached, ignoring anything else stored under the key. @param {unknown} raw */
export function parseLogins(raw) {
  return Array.isArray(raw) ? raw.filter((login) => typeof login === 'string' && login.length > 0) : [];
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

/** Follow the cached logins, keeping a newer change ahead of a slow initial read the way preferences do.
 * @param {typeof chrome.storage} storage
 * @param {(logins: string[]) => void} changed
 */
export function watchLogins(storage, changed) {
  let revision = 0;
  let active = true;
  /** @param {Record<string, chrome.storage.StorageChange>} changes @param {string} area */
  const listener = (changes, area) => {
    if (!active || area !== 'local' || !Object.hasOwn(changes, LOGINS_KEY)) return;
    revision++;
    changed(parseLogins(changes[LOGINS_KEY]?.newValue));
  };
  storage.onChanged.addListener(listener);
  const started = revision;
  void (async () => storage.local.get(LOGINS_KEY))().then((held) => {
    if (active && started === revision) changed(parseLogins(held[LOGINS_KEY]));
  }, () => {
    // An unreadable cache leaves the viewer's own login as the only identity; `@me` still matches.
  });
  return () => { active = false; storage.onChanged.removeListener(listener); };
}
