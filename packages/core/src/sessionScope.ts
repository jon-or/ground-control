import { posix, win32 } from 'node:path';
import { z } from 'zod';

/** Session visibility and route authorization; the complete roster remains available for safety. */
export interface SessionScope {
  includeRepositories: string[];
  excludeRepositories: string[];
  includeDirectories: string[];
  excludeDirectories: string[];
  showHistory: boolean;
  showAdHoc: boolean;
}

export const DEFAULT_SESSION_SCOPE: SessionScope = {
  includeRepositories: [], excludeRepositories: [], includeDirectories: [], excludeDirectories: [],
  showHistory: true, showAdHoc: true,
};

/** Strict repository settings, without credentials or issue/view suffixes. */
export function scopeRepository(raw: string): string | null {
  let value = raw.trim();
  if (/^git@[^/:]+:/.test(value)) value = value.replace(/^git@([^:]+):/, 'ssh://git@$1/');
  if (!value.includes('://')) {
    if (/^[^/:]+\/[^/]+$/.test(value)) value = `https://github.com/${value}`;
    else if (/^[^/:]+\/[^/]+\/[^/]+$/.test(value)) value = `https://${value}`;
    else return null;
  }
  try {
    const url = new URL(value);
    if (!['https:', 'ssh:'].includes(url.protocol) || url.password || url.port || url.search || url.hash ||
      (url.username && !(url.protocol === 'ssh:' && url.username === 'git'))) return null;
    const parts = url.pathname.replace(/\/$/, '').split('/');
    if (parts.length !== 3 || !parts[1] || !parts[2] || !/^[a-z0-9.-]+$/i.test(url.hostname) ||
      !parts.slice(1).every((part) => /^[a-z0-9_.-]+$/i.test(part) && !['.', '..'].includes(part))) return null;
    const repository = parts[2].replace(/\.git$/i, '');
    return repository ? `${url.hostname}/${parts[1]}/${repository}`.toLowerCase() : null;
  } catch { return null; }
}

/** Normalize absolute paths without resolving symlinks; preserve POSIX case and literal backslashes. */
export function scopeDirectory(raw: string): string | null {
  const value = raw;
  if (!value || /[\u0000-\u001f]/.test(value)) return null;
  if (/^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value)) {
    if (/^(?:\\\\|\/\/)[?.][\\/]/.test(value)) return null;
    const normalized = win32.normalize(value).replace(/\\/g, '/').toLowerCase();
    return /^[a-z]:\/$/.test(normalized) ? normalized : normalized.replace(/\/$/, '') || null;
  }
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  return posix.normalize(value).replace(/\/$/, '') || '/';
}

const repository = z.string().transform(scopeRepository).refine((value) => value !== null, 'must name a repository').transform((value) => value!);
const directory = z.string().transform(scopeDirectory).refine((value) => value !== null, 'must be an absolute directory').transform((value) => value!);
export const sessionScopeSchema = z.object({
  includeRepositories: z.array(repository).default([]), excludeRepositories: z.array(repository).default([]),
  includeDirectories: z.array(directory).default([]), excludeDirectories: z.array(directory).default([]),
  showHistory: z.boolean().default(true), showAdHoc: z.boolean().default(true),
}).strict();

export function restrictedSessionScope(scope: SessionScope): boolean {
  return scope.includeRepositories.length + scope.excludeRepositories.length + scope.includeDirectories.length + scope.excludeDirectories.length > 0;
}

/** Unknown repositories fail closed when any repository exclusion is configured. Includes form a union. */
export function sessionInScope(scope: SessionScope, session: { repository: string | null; cwd: string; checkoutRoot?: string | null }): boolean {
  const repository = session.repository === null ? null : scopeRepository(session.repository);
  const directories = [session.cwd, session.checkoutRoot].flatMap((path) => path ? scopeDirectory(path) ?? [] : []);
  const inside = (rules: readonly string[]) => rules.some((raw) => {
    const rule = scopeDirectory(raw);
    return rule !== null && directories.some((path) => path === rule || path.startsWith(rule.endsWith('/') ? rule : `${rule}/`));
  });
  if (inside(scope.excludeDirectories) || (scope.excludeRepositories.length > 0 &&
    (repository === null || scope.excludeRepositories.some((rule) => scopeRepository(rule) === repository)))) return false;
  return scope.includeRepositories.length + scope.includeDirectories.length === 0 ||
    (repository !== null && scope.includeRepositories.some((rule) => scopeRepository(rule) === repository)) || inside(scope.includeDirectories);
}
