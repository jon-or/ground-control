// @ts-check
import { PREFERENCES_KEY, parsePreferences, watchPreferences } from './preferences.js';

const enabled = /** @type {HTMLInputElement} */ (document.getElementById('enabled'));
const animations = /** @type {HTMLInputElement} */ (document.getElementById('animations'));
const replaceAvatars = /** @type {HTMLInputElement} */ (document.getElementById('replaceAvatars'));
const filteredToMe = /** @type {HTMLInputElement} */ (document.getElementById('filteredToMe'));
const cardRows = /** @type {HTMLInputElement} */ (document.getElementById('cardRows'));
const projects = /** @type {HTMLTextAreaElement} */ (document.getElementById('projects'));
const error = /** @type {HTMLElement} */ (document.getElementById('error'));
const status = /** @type {HTMLElement} */ (document.getElementById('status'));
let edited = false;
document.getElementById('preferences')?.addEventListener('input', () => { edited = true; });

watchPreferences(chrome.storage, (state) => {
  if (edited) return;
  enabled.checked = state.value?.enabled ?? false;
  animations.checked = state.value?.animations ?? true;
  replaceAvatars.checked = state.value?.replaceAvatars ?? true;
  filteredToMe.checked = state.value?.filteredToMe ?? true;
  cardRows.checked = state.value?.cardRows ?? true;
  projects.value = state.value?.projects.join('\n') ?? '';
  error.textContent = state.error ?? '';
  status.textContent = state.error ? 'Overlay access is paused until preferences are corrected.' : '';
});

document.getElementById('preferences')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const parsed = parsePreferences({
    enabled: enabled.checked,
    projects: projects.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    animations: animations.checked,
    replaceAvatars: replaceAvatars.checked,
    filteredToMe: filteredToMe.checked,
    cardRows: cardRows.checked,
  });
  status.textContent = '';
  if (parsed.value === null) {
    error.textContent = 'Enter valid HTTPS GitHub project URLs, one per line.';
    return;
  }
  try {
    await chrome.storage.local.set({ [PREFERENCES_KEY]: parsed.value });
    projects.value = parsed.value.projects.join('\n');
    edited = false;
    error.textContent = '';
    status.textContent = 'Preferences saved.';
  } catch {
    error.textContent = 'Could not save preferences. Your previous preferences are still active.';
  }
});
