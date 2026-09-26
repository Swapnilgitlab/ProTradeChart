import { describe, expect, it } from 'vitest';
import type { WatchlistItem, WatchlistSection } from './ipc';
import {
  buildRows,
  dropInsertion,
  fullIndex,
  moveRows,
  refOf,
  sectionSize,
  visibleRows,
  withPositions,
  type Row,
} from './watchlistRows';

const item = (id: number, symbol: string, position: number): WatchlistItem => ({ id, symbol, name: null, position, flag: null });
const section = (id: number, name: string, position: number, collapsed = false): WatchlistSection => ({ id, name, position, collapsed });

/** Reads a list of rows as text: `#Name` for a heading, the symbol otherwise. */
const text = (rows: readonly Row[]) => rows.map((r) => (r.kind === 'section' ? `#${r.name}` : r.symbol));

/** a, #S1 (b, c), #S2 (d) */
function sample(collapse: string[] = []): Row[] {
  return buildRows(
    [item(1, 'a', 1), item(2, 'b', 3), item(3, 'c', 4), item(4, 'd', 6)],
    [section(1, 'S1', 2, collapse.includes('S1')), section(2, 'S2', 5, collapse.includes('S2'))],
  );
}

describe('building the rows', () => {
  it('interleaves symbols and headings by position', () => {
    expect(text(sample())).toEqual(['a', '#S1', 'b', 'c', '#S2', 'd']);
  });

  it('puts a heading before a symbol that shares its position, then goes by id', () => {
    const rows = buildRows([item(5, 'x', 1), item(3, 'y', 1)], [section(9, 'H', 1)]);
    expect(text(rows)).toEqual(['#H', 'y', 'x']);
  });

  it('is just the symbols in order when there are no headings', () => {
    expect(text(buildRows([item(2, 'b', 2), item(1, 'a', 1)], []))).toEqual(['a', 'b']);
  });
});

describe('what a collapsed section hides', () => {
  it('leaves out the symbols under it and nothing else', () => {
    expect(text(visibleRows(sample(['S1'])))).toEqual(['a', '#S1', '#S2', 'd']);
    expect(text(visibleRows(sample(['S2'])))).toEqual(['a', '#S1', 'b', 'c', '#S2']);
  });

  it('shows everything when nothing is collapsed', () => {
    expect(visibleRows(sample())).toHaveLength(6);
  });

  it('counts the symbols a section holds', () => {
    const rows = sample();
    expect(sectionSize(rows, 1)).toBe(2);
    expect(sectionSize(rows, 4)).toBe(1);
  });
});

describe('moving rows', () => {
  it('moves a symbol to just before the row it is dropped on', () => {
    const rows = sample();
    expect(text(moveRows(rows, 0, 3))).toEqual(['#S1', 'b', 'a', 'c', '#S2', 'd']);
    expect(text(moveRows(rows, 5, 2))).toEqual(['a', '#S1', 'd', 'b', 'c', '#S2']);
  });

  it('moves a symbol to the very top or bottom', () => {
    const rows = sample();
    expect(text(moveRows(rows, 3, 0))).toEqual(['c', 'a', '#S1', 'b', '#S2', 'd']);
    expect(text(moveRows(rows, 0, rows.length))).toEqual(['#S1', 'b', 'c', '#S2', 'd', 'a']);
  });

  it('takes a section and its symbols along', () => {
    const rows = sample();
    expect(text(moveRows(rows, 1, rows.length))).toEqual(['a', '#S2', 'd', '#S1', 'b', 'c']);
    expect(text(moveRows(rows, 4, 1))).toEqual(['a', '#S2', 'd', '#S1', 'b', 'c']);
  });

  it('leaves the list alone when a row is dropped where it already is', () => {
    const rows = sample();
    expect(moveRows(rows, 2, 2)).toBe(rows);
    expect(moveRows(rows, 2, 3)).toBe(rows);
    // A section dropped inside its own block.
    expect(moveRows(rows, 1, 2)).toBe(rows);
    expect(moveRows(rows, 1, 4)).toBe(rows);
    expect(moveRows(rows, 99, 0)).toBe(rows);
  });
});

describe('where a dragged row may land', () => {
  it('drops a symbol before or after the row under the pointer, by which half it is on', () => {
    const shown = visibleRows(sample());
    const dragged = shown[0];
    expect(dropInsertion(shown, dragged, 3, false)).toBe(3);
    expect(dropInsertion(shown, dragged, 3, true)).toBe(4);
    expect(dropInsertion(shown, dragged, 5, true)).toBe(6);
  });

  it('clamps a pointer beyond the last row to the end', () => {
    const shown = visibleRows(sample());
    expect(dropInsertion(shown, shown[0], 99, true)).toBe(shown.length);
    expect(dropInsertion(shown, shown[0], -4, false)).toBe(0);
    expect(dropInsertion([], shown[0], 0, false)).toBe(0);
  });

  it('never drops a symbol inside a collapsed section, where it would vanish', () => {
    const shown = visibleRows(sample(['S1'])); // a, #S1, #S2, d
    // Below the collapsed heading is inside its block: read as above it.
    expect(dropInsertion(shown, shown[3], 1, true)).toBe(1);
    expect(dropInsertion(shown, shown[3], 2, false)).toBe(1);
    // The upper half of the heading itself is above it already.
    expect(dropInsertion(shown, shown[3], 1, false)).toBe(1);
  });

  it('reads a run of collapsed headings as the spot above the first', () => {
    const shown = visibleRows(sample(['S1', 'S2'])); // a, #S1, #S2
    expect(dropInsertion(shown, shown[0], 2, true)).toBe(1);
  });

  it('lets a section land only between blocks', () => {
    const shown = visibleRows(sample()); // a, #S1, b, c, #S2, d
    const s2 = shown[4];
    // Over the upper half of the first heading: before that block.
    expect(dropInsertion(shown, s2, 1, false)).toBe(1);
    // Over a symbol inside S1, or the lower half of its heading: after S1's block, before #S2.
    expect(dropInsertion(shown, s2, 2, false)).toBe(4);
    expect(dropInsertion(shown, s2, 3, true)).toBe(4);
    expect(dropInsertion(shown, s2, 1, true)).toBe(4);
    // Over the leading symbols that belong to no section: after them, before #S1.
    expect(dropInsertion(shown, s2, 0, false)).toBe(1);
    // Over the last block: after it, at the end.
    expect(dropInsertion(shown, shown[1], 5, false)).toBe(6);
  });

  it('turns a spot among the shown rows into a spot in the whole list', () => {
    const rows = sample(['S1']);
    const shown = visibleRows(rows); // a, #S1, #S2, d — while b and c are hidden
    expect(fullIndex(rows, shown, 0)).toBe(0);
    expect(fullIndex(rows, shown, 2)).toBe(4); // before #S2 is after the hidden b and c
    expect(fullIndex(rows, shown, shown.length)).toBe(rows.length);
  });

  it('drags a collapsed section past another with its hidden symbols', () => {
    const rows = sample(['S1']);
    const shown = visibleRows(rows);
    const s1 = shown[1];
    const insertion = dropInsertion(shown, s1, 3, true); // below d, the end
    const moved = moveRows(rows, rows.indexOf(s1), fullIndex(rows, shown, insertion));
    expect(text(moved)).toEqual(['a', '#S2', 'd', '#S1', 'b', 'c']);
  });
});

describe('writing the order back', () => {
  it('splits the rows into the two lists, positions counted from 1 in the new order', () => {
    const moved = moveRows(sample(), 0, 6);
    const { items, sections } = withPositions(moved);
    expect(items.map((i) => [i.symbol, i.position])).toEqual([
      ['b', 2],
      ['c', 3],
      ['d', 5],
      ['a', 6],
    ]);
    expect(sections.map((s) => [s.name, s.position])).toEqual([
      ['S1', 1],
      ['S2', 4],
    ]);
    // …and they read back as the same order.
    expect(text(buildRows(items, sections))).toEqual(text(moved));
  });

  it('names a row by kind and id for the backend', () => {
    const rows = sample();
    expect(refOf(rows[0])).toEqual({ kind: 'item', id: 1 });
    expect(refOf(rows[1])).toEqual({ kind: 'section', id: 1 });
  });
});
