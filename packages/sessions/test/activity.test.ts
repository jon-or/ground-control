import { describe, expect, it } from 'vitest';
import {
  TITLE_TAIL_BYTES,
  findTranscript,
  projectSlug,
  projectsRoot,
  titleFrom,
  transcriptCandidates,
} from '../src/providers/claude.js';
import { expectedTitle, listRecordedDirs, readRecordedTails, recordedMtimes, transcripts } from './helpers.js';

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
    // The decoy has to be the exact-case slug: candidates put that first, so anything else is never reached on the
    // first pass and the loop would end there. Only the variant answers, which is the second candidate.
    const entry = found[0]!;
    const slug = projectSlug(entry.cwd);
    const variant = slug.toUpperCase();
    const listing = () => [slug, variant];
    const root = projectsRoot(transcripts.home);
    const mtime = (path: string) =>
      path === `${root}/${variant}/${entry.sessionId}.jsonl` ? entry.writtenAt : null;

    expect(variant).not.toBe(slug);
    expect(mtime(`${root}/${slug}/${entry.sessionId}.jsonl`)).toBeNull();
    expect(findTranscript(transcripts.home, entry.cwd, entry.sessionId, { listDir: listing, mtime })).toEqual({
      path: `${root}/${variant}/${entry.sessionId}.jsonl`,
      writtenAt: entry.writtenAt,
    });
  });

  it('offers a directory whose case differs from the slug, which is where the CLI puts some transcripts', () => {
    // Where the recording carries such a session it is checked directly. It does not always: whether a live session
    // sits under a differently-cased directory is the machine's state, so the variant is derived when it does not.
    if (caseOnly.length > 0) {
      for (const entry of caseOnly) {
        const candidates = transcriptCandidates(transcripts.home, entry.cwd, entry.sessionId, listRecordedDirs);

        expect(candidates).toContain(`${projectsRoot(transcripts.home)}/${entry.dir}/${entry.sessionId}.jsonl`);
      }

      return;
    }

    const entry = found[0]!;
    const variant = entry.dir!.toUpperCase();
    const candidates = transcriptCandidates(transcripts.home, entry.cwd, entry.sessionId, () => [variant]);

    expect(variant).not.toBe(entry.dir);
    expect(candidates).toEqual([`${projectsRoot(transcripts.home)}/${variant}/${entry.sessionId}.jsonl`]);
  });

  it('offers nothing for a checkout that has never held a session', () => {
    expect(transcriptCandidates(transcripts.home, 'd:\\git\\never-opened', 'x', listRecordedDirs)).toEqual([]);
  });

  it('offers nothing when the projects directory itself cannot be read', () => {
    expect(transcriptCandidates(transcripts.home, found[0]!.cwd, 'x', () => null)).toEqual([]);
  });
});

describe('findTranscript', () => {
  it('finds each recorded transcript in the directory it is really in, and nothing for a session without one', () => {
    for (const entry of transcripts.entries) {
      const transcript = findTranscript(transcripts.home, entry.cwd, entry.sessionId, deps);

      expect(transcript?.writtenAt ?? null).toBe(entry.writtenAt);
      expect(transcript?.path ?? null).toBe(
        entry.dir === null ? null : `${projectsRoot(transcripts.home)}/${entry.dir}/${entry.sessionId}.jsonl`,
      );
    }
  });

  it('was recorded where some live sessions had a transcript and some had none', () => {
    expect(found.length).toBeGreaterThan(0);
    expect(transcripts.entries.filter((e) => e.writtenAt === null).length).toBeGreaterThan(0);
  });
});

const titled = transcripts.entries.filter((e) => e.titles.length > 0);
const line = (record: object): string => JSON.stringify(record);

describe('titleFrom', () => {
  it('reads each recorded transcript own title out of the tail it would be handed', () => {
    expect(titled.length).toBeGreaterThan(0);

    for (const entry of titled) {
      const path = `${projectsRoot(transcripts.home)}/${entry.dir}/${entry.sessionId}.jsonl`;
      const tail = readRecordedTails(path, TITLE_TAIL_BYTES)!;

      expect(titleFrom(tail, entry.sessionId)).toBe(expectedTitle(entry));
    }
  });

  it('holds every recorded transcript to the window the reader actually reads', () => {
    for (const entry of found) {
      const inWindow = entry.titleBytesFromEnd !== null && entry.titleBytesFromEnd <= TITLE_TAIL_BYTES;

      expect(entry.titles.length > 0).toBe(inWindow);
    }
  });

  it('was recorded covering a transcript with a title and one with none', () => {
    expect(titled.length).toBeGreaterThan(0);
    expect(found.filter((e) => e.titleBytesFromEnd === null).length).toBeGreaterThan(0);
  });

  it('reads no title when the window is shorter than the distance to the record', () => {
    // A transcript whose title sits beyond the window is the machine's state to provide, not a shape to arrange, so
    // the window is narrowed instead. The recording carried one on 2026-09-02 at 2.2 MB from the end.
    const entry = titled[0]!;
    const path = `${projectsRoot(transcripts.home)}/${entry.dir}/${entry.sessionId}.jsonl`;
    const clipped = readRecordedTails(path, 200)!;

    expect(clipped.length).toBe(200);
    expect(titleFrom(clipped, entry.sessionId)).toBeNull();
    expect(titleFrom(readRecordedTails(path, TITLE_TAIL_BYTES)!, entry.sessionId)).toBe(expectedTitle(entry));
  });

  it('lets the title the developer set outrank the one the agent went on writing', () => {
    // No live session on this machine had a manual title to record, so the pairing is derived from a recorded
    // automatic one. The order is the one measured: the CLI keeps writing its own title after a manual one is set.
    const automatic = titled[0]!.titles[0]!;
    const manual = { type: 'custom-title', customTitle: 'the name I gave it', sessionId: automatic.sessionId };
    const tail = [line(automatic), line(manual), line(automatic)].join('\n');

    expect(titleFrom(tail, automatic.sessionId)).toBe('the name I gave it');
  });

  it('takes the last of a kind, so a retitled session reads as its current title', () => {
    const first = titled[0]!.titles[0]!;
    const later = { ...first, aiTitle: 'what it is doing now' };

    expect(titleFrom([line(first), line(later)].join('\n'), first.sessionId)).toBe('what it is doing now');
  });

  it('ignores a record belonging to another session, which a forked transcript carries', () => {
    const record = titled[0]!.titles[0]!;

    expect(titleFrom(line(record), 'a-different-session')).toBeNull();
  });

  it('ignores a blank title rather than showing a card with no name', () => {
    const record = { type: 'ai-title', aiTitle: '   ', sessionId: 'session-1' };

    expect(titleFrom(line(record), 'session-1')).toBeNull();
  });

  it('skips the fragment a read cuts through, even one that holds the word', () => {
    const record = titled[0]!.titles[0]!;
    const fragment = 'ext":"and then set the title of the report"}]}}';

    expect(titleFrom([fragment, line(record)].join('\n'), record.sessionId)).toBe(expectedTitle(titled[0]!));
  });

  it('reads nothing out of a tail that carries no title record', () => {
    expect(titleFrom('{"type":"user","message":{"role":"user"}}', 'session-1')).toBeNull();
    expect(titleFrom('', 'session-1')).toBeNull();
  });
});
