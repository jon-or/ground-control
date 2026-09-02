import { describe, expect, it } from 'vitest';
import { projectSlug, projectsRoot, transcriptCandidates, transcriptWrittenAt } from '../src/providers/claude.js';
import { listRecordedDirs, recordedMtimes, transcripts } from './helpers.js';

const deps = { mtime: recordedMtimes, listDir: listRecordedDirs };
const found = transcripts.entries.filter((e) => e.dir !== null);
const caseOnly = found.filter((e) => e.dir !== projectSlug(e.cwd));

describe('projectSlug', () => {
  it('replaces the drive colon, both separators, and the dot', () => {
    expect(projectSlug('d:\\work\\repo.worktrees\\18941-inbox-badge')).toBe(
      'd--work-repo-worktrees-18941-inbox-badge',
    );
  });

  it('replaces every other non-alphanumeric too', () => {
    // Measured: a session started in `…\slug probe_x+y~z` produced `…-slug-probe-x-y-z`.
    expect(projectSlug('D:\\git\\dev-tracker\\.claude\\personal\\slug probe_x+y~z')).toBe(
      'D--git-dev-tracker--claude-personal-slug-probe-x-y-z',
    );
    expect(projectSlug('/home/dev/work (main)')).toBe('-home-dev-work--main-');
  });

  it('does not collapse runs of them', () => {
    expect(projectSlug('d:\\\\git')).toBe('d---git');
  });
});

describe('transcriptCandidates', () => {
  it('offers the exact-case directory before any other casing', () => {
    // No directory on this machine exists in two casings at once, so the collision is derived here rather than
    // recorded: the exact slug must be tried first even when a variant is listed ahead of it.
    const entry = found.find((e) => e.dir === projectSlug(e.cwd))!;
    const slug = projectSlug(entry.cwd);
    const variant = slug.toUpperCase() === slug ? slug.toLowerCase() : slug.toUpperCase();
    const listing = () => [variant, slug];

    const candidates = transcriptCandidates(transcripts.home, entry.cwd, entry.sessionId, listing);
    const root = projectsRoot(transcripts.home);

    expect(candidates).toEqual([`${root}/${slug}/${entry.sessionId}.jsonl`, `${root}/${variant}/${entry.sessionId}.jsonl`]);
  });

  it('keeps looking past a directory that does not hold the transcript', () => {
    // The decoy has to be a casing of the same slug, or the filter drops it and the loop never runs twice.
    const entry = found.find((e) => e.dir!.toUpperCase() !== e.dir)!;
    const listing = () => [entry.dir!.toUpperCase(), entry.dir!];

    expect(listing()[0]).not.toBe(entry.dir);
    expect(transcriptWrittenAt(transcripts.home, entry.cwd, entry.sessionId, { ...deps, listDir: listing })).toBe(
      entry.writtenAt,
    );
  });

  it('offers a differently-cased directory, which is where the CLI actually put some transcripts', () => {
    expect(caseOnly.length).toBeGreaterThan(0);

    for (const entry of caseOnly) {
      const candidates = transcriptCandidates(transcripts.home, entry.cwd, entry.sessionId, listRecordedDirs);

      expect(candidates).toContain(`${projectsRoot(transcripts.home)}/${entry.dir}/${entry.sessionId}.jsonl`);
    }
  });

  it('offers nothing for a checkout that has never held a session', () => {
    expect(transcriptCandidates(transcripts.home, 'd:\\git\\never-opened', 'x', listRecordedDirs)).toEqual([]);
  });

  it('offers nothing when the projects directory itself cannot be read', () => {
    expect(transcriptCandidates(transcripts.home, found[0]!.cwd, 'x', () => null)).toEqual([]);
  });
});

describe('transcriptWrittenAt', () => {
  it('finds each recorded session write time in the directory it is really in', () => {
    for (const entry of transcripts.entries) {
      expect(transcriptWrittenAt(transcripts.home, entry.cwd, entry.sessionId, deps)).toBe(entry.writtenAt);
    }
  });

  it('was recorded where some live sessions had no transcript and some resolved only by case', () => {
    expect(found.length).toBeGreaterThan(0);
    expect(transcripts.entries.filter((e) => e.writtenAt === null).length).toBeGreaterThan(0);
    expect(caseOnly.length).toBeGreaterThan(0);
  });
});
