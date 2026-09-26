/** A watchlist as the rows people see: symbols and section headings in one sequence.
 *
 *  Pure, so the parts that are easy to get wrong — what a collapsed section hides, where a dragged row may
 *  land, what moving a section takes with it — are tested without a component. */

import type { RowRef, WatchlistItem, WatchlistSection } from './ipc';

export type ItemRow = WatchlistItem & { kind: 'item' };
export type SectionRow = WatchlistSection & { kind: 'section' };
export type Row = ItemRow | SectionRow;

export const isSection = (row: Row): row is SectionRow => row.kind === 'section';
export const isItem = (row: Row): row is ItemRow => row.kind === 'item';

export const refOf = (row: Row): RowRef => ({ kind: row.kind, id: row.id });
export const rowKey = (row: Row): string => `${row.kind}:${row.id}`;

/** The list's symbols and headings as one sequence. Same order as the backend: by position, a heading
 *  before a symbol that shares it, then by id. */
export function buildRows(items: readonly WatchlistItem[], sections: readonly WatchlistSection[]): Row[] {
  const rows: Row[] = [
    ...sections.map((s): Row => ({ ...s, kind: 'section' })),
    ...items.map((i): Row => ({ ...i, kind: 'item' })),
  ];
  const rank = (row: Row) => (row.kind === 'section' ? 0 : 1);
  return rows.sort((a, b) => a.position - b.position || rank(a) - rank(b) || a.id - b.id);
}

/** The rows on screen: the symbols under a collapsed section are left out. */
export function visibleRows(rows: readonly Row[]): Row[] {
  const shown: Row[] = [];
  let hidden = false;
  for (const row of rows) {
    if (row.kind === 'section') {
      hidden = row.collapsed;
      shown.push(row);
    } else if (!hidden) {
      shown.push(row);
    }
  }
  return shown;
}

/** How many symbols a section holds, by the index of its heading in `rows`. */
export function sectionSize(rows: readonly Row[], index: number): number {
  let count = 0;
  for (let i = index + 1; i < rows.length && rows[i].kind === 'item'; i++) count++;
  return count;
}

/** Where the block starting at `index` ends (exclusive): a section takes the symbols under it, a symbol is
 *  only itself. */
function blockEnd(rows: readonly Row[], index: number): number {
  if (rows[index].kind !== 'section') return index + 1;
  let end = index + 1;
  while (end < rows.length && rows[end].kind === 'item') end++;
  return end;
}

/** `rows` with the row at `from` — and, for a section, the symbols under it — taken out and put back before
 *  the row that stood at `before` (`rows.length` means the end). Returns `rows` itself when that changes
 *  nothing, so a drop where it started is recognisable. */
export function moveRows(rows: readonly Row[], from: number, before: number): readonly Row[] {
  if (from < 0 || from >= rows.length) return rows;
  const end = blockEnd(rows, from);
  if (before >= from && before <= end) return rows;
  const moving = rows.slice(from, end);
  const rest = [...rows.slice(0, from), ...rows.slice(end)];
  rest.splice(before > from ? before - moving.length : before, 0, ...moving);
  return rest;
}

/** Where, in the shown rows, a dragged row would be inserted: `at` is the shown row the pointer is over and
 *  `lowerHalf` says which half of it. The result is an index from 0 to `shown.length`, meaning "before that
 *  row" (`shown.length` is the end).
 *
 *  Two rules keep a drop from doing something the eye wouldn't expect:
 *  - a symbol can't land inside a collapsed section — it would vanish — so a spot right under a collapsed
 *    heading is read as the spot above it;
 *  - a section moves with its symbols, so it can only land between blocks (before another heading, or at the
 *    end), never inside one. */
export function dropInsertion(shown: readonly Row[], dragged: Row, at: number, lowerHalf: boolean): number {
  if (shown.length === 0) return 0;
  const over = Math.min(Math.max(at, 0), shown.length - 1);

  if (dragged.kind === 'section') {
    // The heading the pointer's block belongs to, if any.
    let head = over;
    while (head >= 0 && shown[head].kind !== 'section') head--;
    if (head === over && !lowerHalf) return over; // upper half of a heading: before that block
    let next = over + 1;
    while (next < shown.length && shown[next].kind !== 'section') next++;
    return next;
  }

  let insertion = over + (lowerHalf ? 1 : 0);
  // Repeats for a run of collapsed headings: the gap between two of them is inside the first one's block too.
  while (insertion > 0) {
    const above = shown[insertion - 1];
    if (above.kind !== 'section' || !above.collapsed) break;
    insertion--;
  }
  return insertion;
}

/** Where `insertion` (an index into the shown rows) falls in the whole list, which also holds the rows a
 *  collapsed section hides. */
export function fullIndex(rows: readonly Row[], shown: readonly Row[], insertion: number): number {
  if (insertion >= shown.length) return rows.length;
  const index = rows.indexOf(shown[insertion]);
  return index === -1 ? rows.length : index;
}

/** `rows` split back into the two lists the backend keeps, positions renumbered to match the order. */
export function withPositions(rows: readonly Row[]): { items: WatchlistItem[]; sections: WatchlistSection[] } {
  const items: WatchlistItem[] = [];
  const sections: WatchlistSection[] = [];
  rows.forEach((row, i) => {
    const { kind, ...rest } = row;
    const position = i + 1;
    if (kind === 'section') sections.push({ ...(rest as WatchlistSection), position });
    else items.push({ ...(rest as WatchlistItem), position });
  });
  return { items, sections };
}
