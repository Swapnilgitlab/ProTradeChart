/** A line diff between two versions of a script, for showing the AI assistant's proposal as changes. Pure.
 *
 *  The common start and end are trimmed first (most proposals change a few lines of a long file), then the
 *  middle is compared line by line with a longest-common-subsequence table. That table is quadratic, so a
 *  middle too large for it is shown as removed-then-added rather than freezing the window. */

export type DiffKind = 'same' | 'add' | 'del';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the old version (`same`, `del`) and the new one (`same`, `add`). */
  oldNo: number | null;
  newNo: number | null;
}

/** Above this many cells, the middle isn't compared line by line. */
const MAX_TABLE_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: 'same', text: a[i], oldNo: i + 1, newNo: i + 1 });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_TABLE_CELLS) {
    midA.forEach((text, i) => out.push({ kind: 'del', text, oldNo: start + i + 1, newNo: null }));
    midB.forEach((text, j) => out.push({ kind: 'add', text, oldNo: null, newNo: start + j + 1 }));
  } else {
    // lcs[i * (m + 1) + j]: the longest common subsequence of midA[i..] and midB[j..].
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] = midA[i] === midB[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ kind: 'same', text: midA[i], oldNo: start + i + 1, newNo: start + j + 1 });
        i++;
        j++;
      } else if (i < n && (j === m || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
        // On a tie the old line goes first, so a changed line reads as removed-then-added.
        out.push({ kind: 'del', text: midA[i], oldNo: start + i + 1, newNo: null });
        i++;
      } else {
        out.push({ kind: 'add', text: midB[j], oldNo: null, newNo: start + j + 1 });
        j++;
      }
    }
  }

  const shift = b.length - a.length;
  for (let i = endA; i < a.length; i++) out.push({ kind: 'same', text: a[i], oldNo: i + 1, newNo: i + 1 + shift });
  return out;
}

export function diffCounts(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'del') removed++;
  }
  return { added, removed };
}

/** A stretch of the diff worth showing: the changed lines and `context` unchanged lines either side.
 *  `skipped` is how many unchanged lines were left out before it. */
export interface Hunk {
  skipped: number;
  lines: DiffLine[];
}

export function hunks(lines: readonly DiffLine[], context = 3): { hunks: Hunk[]; trailing: number } {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const result: Hunk[] = [];
  let skipped = 0;
  let current: Hunk | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      current = null;
      skipped++;
      continue;
    }
    if (!current) {
      current = { skipped, lines: [] };
      result.push(current);
      skipped = 0;
    }
    current.lines.push(lines[i]);
  }
  return { hunks: result, trailing: skipped };
}
