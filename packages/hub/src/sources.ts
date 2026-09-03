import { z } from 'zod';
import type { GithubConfig } from '@ground-control/github';
import { spawnable } from '@ground-control/core';
import type { ReadFailure } from '@ground-control/core';

/**
 * The GitHub entry in a pushed configuration. Parsed here rather than trusted, because a client is not necessarily
 * this editor: `ghPath` becomes a process, and `maxPages` bounds how much of someone's GitHub a client can ask for.
 */
const github = z
  .object({
    ghPath: spawnable.default('gh'),
    repo: z.string().min(1),
    logins: z.array(z.string()).default([]),
    projectNumber: z.number().int().nonnegative().default(0),
    cardSource: z.enum(['project', 'issueSearch']).default('project'),
    maxPages: z.number().int().min(1).max(20).default(5),
  })
  .strict();

export function readGithubConfig(raw: unknown): { config: GithubConfig } | { failure: ReadFailure } {
  const parsed = github.safeParse(raw ?? {});

  if (parsed.success) {
    return { config: parsed.data };
  }

  const issue = parsed.error.issues[0];

  return {
    failure: {
      subject: 'github',
      kind: 'bad-config',
      message: `The GitHub settings could not be read: ${issue?.path.join('.') || 'the value'} ${issue?.message ?? 'is not valid'}.`,
      remedy: 'Fix the groundControl.github settings, or remove them to use the defaults.',
    },
  };
}
