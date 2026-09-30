/** Cells that hold a place for evidence rather than evidence. */
const PLACEHOLDERS = new Set(['', '-', '—', '–', 'todo', 'tbd', 'none', 'pending', '?', 'n/a']);

export type EvidenceCheck = { ok: true; rows: number } | { ok: false; reason: string };

function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');

  // A backslash-escaped pipe belongs to its cell.
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function isTableLine(line: string): boolean {
  return line.trim().startsWith('|');
}

function isDelimiter(line: string): boolean {
  return cells(line).every((cell) => /^:?-{1,}:?$/.test(cell));
}

/** The lines outside fenced code blocks; a table shown as an example is not the ledger. */
function unfenced(text: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;

  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];

    if (marker !== undefined && (fence === null || marker.startsWith(fence))) {
      fence = fence === null ? marker : null;
      lines.push('');
    } else {
      lines.push(fence === null ? line : '');
    }
  }

  return lines;
}

/**
 * Check an evidence ledger before a card enters Review (R23, R49): every Markdown table whose header has a column
 * starting `Evidence` must have rows, and every row a cell there that is not empty or a placeholder.
 */
export function checkEvidence(text: string): EvidenceCheck {
  const lines = unfenced(text);
  let total = 0;
  const missing: string[] = [];
  let empty = false;

  for (let index = 0; index + 1 < lines.length; index++) {
    const header = lines[index]!;

    if (!isTableLine(header) || !isTableLine(lines[index + 1]!) || !isDelimiter(lines[index + 1]!)) {
      continue;
    }

    const column = cells(header).findIndex((cell) => /^evidence\b/i.test(cell));

    if (column === -1) {
      continue;
    }

    let row = index + 2;

    for (; row < lines.length && isTableLine(lines[row]!); row++) {
      const values = cells(lines[row]!);
      total++;

      if (PLACEHOLDERS.has((values[column] ?? '').toLowerCase())) {
        missing.push(values.find((cell, at) => at !== column && cell !== '') ?? '(unnamed row)');
      }
    }

    empty ||= row === index + 2;
    index = row - 1;
  }

  if (total === 0) {
    return { ok: false, reason: empty ? 'The evidence table has no rows.' : 'No Markdown table with an Evidence column.' };
  }

  return missing.length > 0
    ? { ok: false, reason: `${missing.length} of ${total} rows have no evidence: ${missing.join('; ')}.` }
    : { ok: true, rows: total };
}
