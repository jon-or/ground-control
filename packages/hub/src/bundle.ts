/**
 * The hub runs from one path on disk, whichever client put it there, so a native-messaging manifest or a saved
 * command line keeps working across an extension update. Which copy wins is decided here rather than by whoever
 * activated last: an older client must never replace a newer hub.
 */
const MARKER = '// ground-control-hub ';

/** The version of a bundle already on disk, or null for a file this did not write. */
export function versionOf(text: string | null): string | null {
  if (text === null || !text.startsWith(MARKER)) {
    return null;
  }

  const line = text.slice(MARKER.length, text.indexOf('\n'));

  return line.trim() === '' ? null : line.trim();
}

/** Stamps a bundle with the version that carried it, so the next client can compare without running it. */
export function stamp(version: string, code: string): string {
  return `${MARKER}${version}\n${code}`;
}

/** Dotted numbers, compared as numbers. A part that is not a number sorts below every part that is. */
export function compareVersions(left: string, right: string): number {
  const a = left.split('.');
  const b = right.split('.');

  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const one = Number(a[index] ?? 0);
    const other = Number(b[index] ?? 0);

    if (Number.isNaN(one) || Number.isNaN(other)) {
      return Number.isNaN(one) && Number.isNaN(other) ? 0 : Number.isNaN(one) ? -1 : 1;
    }

    if (one !== other) {
      return one < other ? -1 : 1;
    }
  }

  return 0;
}

/**
 * Whether the bundle a client carries should replace the one on disk. Newer wins; an older one never writes. Equal
 * versions compare bytes, which is the development case — every build in a source tree carries the same version.
 */
export function shouldWrite(carried: string, onDisk: string | null): boolean {
  if (onDisk === null) {
    return true;
  }

  const theirs = versionOf(onDisk);
  const ours = versionOf(carried);

  // A file this did not stamp is not one to reason about by version: something else wrote it, and ours is known good.
  if (theirs === null || ours === null) {
    return carried !== onDisk;
  }

  const order = compareVersions(ours, theirs);

  return order > 0 || (order === 0 && carried !== onDisk);
}
