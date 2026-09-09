import type { GithubConfig } from './types.js';

/** The project owner setting, or the repository owner when it is empty. */
export function projectOwnerOf(cfg: Pick<GithubConfig, 'repo' | 'projectOwner'>): string {
  return cfg.projectOwner !== '' ? cfg.projectOwner : (cfg.repo.split('/')[0] ?? '');
}

/** Project identity is owner plus number; equal numbers under different owners are different projects. */
export function onConfiguredProject(
  project: { number: number; owner?: { login?: string | undefined } | null | undefined },
  cfg: Pick<GithubConfig, 'repo' | 'projectOwner' | 'projectNumber'>,
): boolean {
  if (project.number !== cfg.projectNumber) {
    return false;
  }

  const owner = project.owner;

  // Recordings made before the owner was requested carry none; the number alone decides for them. An owner
  // of a type without a login is not the configured organization or user.
  if (owner === undefined || owner === null) {
    return true;
  }

  return owner.login !== undefined && owner.login.toLowerCase() === projectOwnerOf(cfg).toLowerCase();
}
