/** The Screener's chart view: its results as pages of candlestick charts, 1×1 to 2×2. Pure. */

export interface Grid {
  id: GridId;
  rows: number;
  cols: number;
  label: string;
}

export type GridId = '1x1' | '1x2' | '2x1' | '2x2';

export const GRIDS: readonly Grid[] = [
  { id: '1x1', rows: 1, cols: 1, label: '1 × 1' },
  { id: '1x2', rows: 1, cols: 2, label: '1 × 2' },
  { id: '2x1', rows: 2, cols: 1, label: '2 × 1' },
  { id: '2x2', rows: 2, cols: 2, label: '2 × 2' },
];

export const gridById = (id: string): Grid => GRIDS.find((g) => g.id === id) ?? GRIDS[3];

export const perPage = (grid: Grid) => grid.rows * grid.cols;

/** How much history each chart frames: Vela's own range presets, so a chart loads that depth in one pass. */
export type RangeId = '1M' | '3M' | '6M' | '1Y' | '5Y' | 'ALL';

export const RANGES: readonly { id: RangeId; label: string }[] = [
  { id: '1M', label: '1M' },
  { id: '3M', label: '3M' },
  { id: '6M', label: '6M' },
  { id: '1Y', label: '1Y' },
  { id: '5Y', label: '5Y' },
  { id: 'ALL', label: 'All' },
];

/** A saved choice, or a year when there is none (or it's no longer offered). */
export const rangeById = (id: string): RangeId => RANGES.find((r) => r.id === id)?.id ?? '1Y';

export const pageCount = (total: number, grid: Grid) => Math.max(1, Math.ceil(total / perPage(grid)));

/** The page index kept in range after the results or the grid change. */
export const clampPage = (page: number, total: number, grid: Grid) => Math.min(Math.max(0, page), pageCount(total, grid) - 1);

/** The symbols on page `page`. */
export function pageSymbols<T>(items: readonly T[], page: number, grid: Grid): T[] {
  const n = perPage(grid);
  return items.slice(page * n, page * n + n);
}

/** The grid a page is drawn in: the chosen one, or a smaller one for a last page with fewer charts
 *  than cells (a chart can't be left empty), keeping the grid's orientation where it can. */
export function shapeFor(grid: Grid, count: number): { rows: number; cols: number } {
  if (count >= perPage(grid)) return { rows: grid.rows, cols: grid.cols };
  if (count <= 1) return { rows: 1, cols: 1 };
  if (count === 2) return grid.cols >= 2 ? { rows: 1, cols: 2 } : { rows: 2, cols: 1 };
  return { rows: 1, cols: count };
}

/** "5–8 of 37". */
export function pageRange(page: number, total: number, grid: Grid): string {
  if (total === 0) return '0 of 0';
  const n = perPage(grid);
  const first = page * n + 1;
  const last = Math.min(total, first + n - 1);
  return first === last ? `${first} of ${total}` : `${first}–${last} of ${total}`;
}
