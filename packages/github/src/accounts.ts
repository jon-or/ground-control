import { z } from 'zod';
import type { Logger } from '@ground-control/core';
import type { GhRunner } from './gh.js';
import { PROFILE_QUERY } from './queries.js';

/** What a linked account shows instead of the alias: the target's login, profile name, and face. */
export interface Profile {
  login: string;
  name: string | null;
  avatarUrl: string;
}

/** One cached profile read. A failed read keeps the last profile, if any, and records when to try again. */
export interface ProfileEntry {
  profile: Profile | null;
  at: number;
  failedAt?: number;
}

/** Normalized links: lowercase alias to the target login as configured. */
export type AccountLinks = Readonly<Record<string, string>>;

export type Profiles = ReadonlyMap<string, ProfileEntry>;

/** A resolved actor: the login shown, its avatar and name, and the login GitHub recorded when they differ. */
export interface ResolvedActor {
  login: string;
  avatarUrl: string | null;
  name: string | null;
  aliasOf?: string;
}

export const PROFILE_FRESH_MS = 24 * 60 * 60 * 1000;
export const PROFILE_RETRY_MS = 60 * 60 * 1000;
const PROFILE_TIMEOUT_MS = 20_000;

/** GitHub logins, including the `[bot]` suffix of app accounts; anything else never reaches a query. */
const LOGIN = /^[A-Za-z0-9-]+(\[bot\])?$/;

const profileResponse = z.object({
  data: z.object({
    user: z.object({ login: z.string(), name: z.string().nullable().default(null), avatarUrl: z.string() }).nullable(),
  }),
});

/**
 * Keep the links that can resolve: string pairs, distinct logins, no chains. A pair of mutual links drops both
 * sides. Warn once per dropped entry and once per alias in `logins` whose target is not, because that target
 * becomes a developer identity (R28).
 */
export function normalizeLinks(raw: unknown, logins: readonly string[], log?: Logger): AccountLinks {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {};
  }

  const entries: [string, string][] = [];

  for (const [key, value] of Object.entries(raw)) {
    const alias = key.trim();
    const target = typeof value === 'string' ? value.trim() : '';

    if (!LOGIN.test(alias) || !LOGIN.test(target)) {
      log?.warn(`Ignoring linked account "${key}": both sides must be GitHub logins.`, 'github');
    } else if (alias.toLowerCase() === target.toLowerCase()) {
      log?.warn(`Ignoring linked account "${key}": it links to itself.`, 'github');
    } else {
      entries.push([alias, target]);
    }
  }

  const aliases = new Set(entries.map(([alias]) => alias.toLowerCase()));
  const links: Record<string, string> = {};
  const known = new Set(logins.map((login) => login.toLowerCase()));

  for (const [alias, target] of entries) {
    if (aliases.has(target.toLowerCase())) {
      log?.warn(`Ignoring linked account "${alias}": its target ${target} is itself linked.`, 'github');

      continue;
    }

    if (alias.toLowerCase() in links) {
      log?.warn(`Ignoring linked account "${alias}": it repeats another entry in a different case.`, 'github');

      continue;
    }

    if (known.has(alias.toLowerCase()) && !known.has(target.toLowerCase())) {
      log?.warn(`${target} becomes a developer identity: ${alias} is in github.logins and links to it.`, 'github');
    }

    links[alias.toLowerCase()] = target;
  }

  return links;
}

/** The distinct targets of the links, as configured. */
export function linkTargets(links: AccountLinks): string[] {
  return dedupeLogins(Object.values(links));
}

/**
 * Read the profile of every target whose entry is missing, older than a day, or failed over an hour ago. A failed
 * read keeps the last profile and, with none, leaves the alias its own face under the target's login. Transient,
 * credential, and missing-CLI failures leave the entry untouched: the next board read reports and retries them.
 */
export async function fetchProfiles(run: GhRunner, targets: readonly string[], cache: Map<string, ProfileEntry>, now: number, log?: Logger): Promise<void> {
  const due = targets.filter((target) => {
    const entry = cache.get(target.toLowerCase());

    return entry === undefined || (entry.failedAt === undefined ? now - entry.at >= PROFILE_FRESH_MS : now - entry.failedAt >= PROFILE_RETRY_MS);
  });

  await Promise.all(
    due.map(async (target) => {
      const raw = await run(['api', 'graphql', '-f', `query=${PROFILE_QUERY}`, '-f', `login=${target}`], { timeoutMs: PROFILE_TIMEOUT_MS });
      const key = target.toLowerCase();
      const held = cache.get(key);

      if (!raw.ok && (raw.error.transient === true || raw.error.kind === 'not-authenticated' || raw.error.kind === 'gh-missing')) {
        return;
      }

      const parsed = raw.ok ? profileResponse.safeParse(raw.value) : null;
      const user = parsed?.success ? parsed.data.data.user : null;

      if (user === null) {
        if (held?.profile === undefined || (held.profile === null && held.failedAt === undefined)) {
          const why = raw.ok ? 'GitHub returned no user' : raw.error.message;
          log?.warn(`Could not read the profile of linked account ${target}: ${why}`, 'github');
        }

        cache.set(key, { profile: held?.profile ?? null, at: held?.at ?? now, failedAt: now });

        return;
      }

      cache.set(key, { profile: { login: user.login, name: user.name, avatarUrl: user.avatarUrl }, at: now });
    }),
  );
}

/** The login a linked alias shows as, or the login itself. */
export function resolveLogin(links: AccountLinks, profiles: Profiles, login: string): string {
  const target = links[login.toLowerCase()];

  return target === undefined ? login : profiles.get(target.toLowerCase())?.profile?.login ?? target;
}

/** The actor a linked alias shows as. An unlinked actor comes back with its own fields and no `aliasOf`. */
export function resolveActor(
  links: AccountLinks,
  profiles: Profiles,
  actor: { login: string; avatarUrl?: string | null | undefined; name?: string | null | undefined },
): ResolvedActor {
  const target = links[actor.login.toLowerCase()];

  if (target === undefined) {
    return { login: actor.login, avatarUrl: actor.avatarUrl ?? null, name: actor.name ?? null };
  }

  const profile = profiles.get(target.toLowerCase())?.profile ?? null;

  return {
    login: profile?.login ?? target,
    avatarUrl: profile?.avatarUrl ?? actor.avatarUrl ?? null,
    name: profile?.name ?? null,
    aliasOf: actor.login,
  };
}

/** Drop repeated logins, ignoring case, keeping the first. */
export function dedupeLogins(logins: readonly string[]): string[] {
  const seen = new Set<string>();

  return logins.filter((login) => {
    const key = login.toLowerCase();

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

/**
 * Drop repeated actors, ignoring case. An actor GitHub recorded directly wins over one standing in for an alias,
 * so a developer assigned beside their bot reads as directly assigned.
 */
export function dedupeActors<T extends { login: string; aliasOf?: string | undefined }>(actors: readonly T[]): T[] {
  const kept = new Map<string, T>();

  for (const actor of actors) {
    const key = actor.login.toLowerCase();
    const existing = kept.get(key);

    if (existing === undefined || (existing.aliasOf !== undefined && actor.aliasOf === undefined)) {
      kept.set(key, actor);
    }
  }

  return [...kept.values()];
}
