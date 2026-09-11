import { commonDirOf, gitDirOf } from './gitDir.js';
import type { ReadText } from './machine.js';
import { join, normalize, parent } from './paths.js';

/** HTTPS and SSH remotes, and issue URLs, compared without credentials or a transport-specific spelling. */
export function repositoryKey(value: string): string | null {
  const url = value.replace(/^git@([^:]+):/, 'https://$1/');
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (!parsed.hostname || parts.length < 2 || !parts[0] || !parts[1]) return null;
    return `${parsed.hostname}/${parts[0]}/${parts[1].replace(/\.git$/i, '')}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Git config permits quoted values and comments outside quotes. Never keep credentials in the resulting key. */
function configValue(raw: string): string | null {
  let result = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && (char === '#' || char === ';')) break;
    if (char === '\\') {
      const escaped = raw[++i];
      const value = escaped && ({ n: '\n', t: '\t', b: '\b', '"': '"', '\\': '\\' } as Record<string, string>)[escaped];
      if (value === undefined) return null;
      result += value;
    } else result += char;
  }
  return quoted ? null : result.trim();
}

/**
 * Origin identity recorded in a git directory. Null where the config names no usable origin, and undefined
 * where it has no config at all, which is what tells a caller to keep searching.
 */
export function repositoryAt(configDir: string, read: ReadText): string | null | undefined {
  const config = read(join(configDir, 'config'));

  if (config === null) {
    return undefined;
  }

  const origin = config.match(/^\s*\[remote\s+"origin"\]\s*\r?\n([^\[]*)/m)?.[1];
  const raw = origin?.match(/^\s*url\s*=\s*(.*?)\s*$/m)?.[1];
  const url = raw ? configValue(raw) : null;

  return url ? repositoryKey(url) : null;
}

/** A worktree shares its remote configuration through commondir. HEAD is deliberately never read. */
export function repositoryOf(cwd: string, read: ReadText): string | null {
  let dir: string | null = normalize(cwd);
  while (dir) {
    const found = repositoryAt(commonDirOf(gitDirOf(dir, read), read), read);
    if (found !== undefined) {
      return found;
    }
    dir = parent(dir);
  }
  return null;
}
