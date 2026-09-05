import type { ReadText } from './machine.js';
import { isAbsolute, join, normalize, parent } from './paths.js';

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

/** A worktree shares its remote configuration through commondir. HEAD is deliberately never read. */
export function repositoryOf(cwd: string, read: ReadText): string | null {
  let dir: string | null = normalize(cwd);
  while (dir) {
    const dotGit = join(dir, '.git');
    const pointer = read(dotGit)?.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
    const gitDir = pointer ? (isAbsolute(pointer) ? normalize(pointer) : join(dir, pointer)) : dotGit;
    const common = read(join(gitDir, 'commondir'))?.trim();
    const configDir = common ? (isAbsolute(common) ? normalize(common) : join(gitDir, common)) : gitDir;
    const config = read(join(configDir, 'config'));
    if (config !== null) {
      const origin = config.match(/^\s*\[remote\s+"origin"\]\s*\r?\n([^\[]*)/m)?.[1];
      const raw = origin?.match(/^\s*url\s*=\s*(.*?)\s*$/m)?.[1];
      const url = raw ? configValue(raw) : null;
      return url ? repositoryKey(url) : null;
    }
    dir = parent(dir);
  }
  return null;
}
