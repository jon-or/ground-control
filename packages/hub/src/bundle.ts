/** Use a stable hub path across extension updates. Newer versions replace older bundles, never the reverse. */
const MARKER = '// ground-control-hub ';

/** Read the version stamp, or null for an unstamped bundle. */
export function versionOf(text: string | null): string | null {
  if (text === null || !text.startsWith(MARKER)) {
    return null;
  }

  const line = text.slice(MARKER.length, text.indexOf('\n'));

  return line.trim() === '' ? null : line.trim();
}

/** Stamp the bundle version for comparison without execution. */
export function stamp(version: string, code: string): string {
  return `${MARKER}${version}\n${code}`;
}

/** Compare dotted numeric versions; nonnumeric parts sort below numeric parts. */
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

/** Replace older bundles. For equal versions, compare contents to support development builds. */
export function shouldWrite(carried: string, onDisk: string | null): boolean {
  if (onDisk === null) {
    return true;
  }

  const theirs = versionOf(onDisk);
  const ours = versionOf(carried);

  // Replace unstamped files with the client's bundled hub.
  if (theirs === null || ours === null) {
    return carried !== onDisk;
  }

  const order = compareVersions(ours, theirs);

  return order > 0 || (order === 0 && carried !== onDisk);
}
