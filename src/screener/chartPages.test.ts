import { describe, expect, it } from 'vitest';
import { clampPage, gridById, pageCount, pageRange, pageSymbols, rangeById, RANGES, shapeFor } from './chartPages';

const symbols = Array.from({ length: 10 }, (_, i) => `S${i + 1}`);

describe('the Screener chart pages', () => {
  it('frames a year unless another offered range was chosen', () => {
    expect(rangeById('6M')).toBe('6M');
    expect(rangeById('2Y')).toBe('1Y');
    expect(rangeById('')).toBe('1Y');
    expect(RANGES.map((r) => r.id)).toEqual(['1M', '3M', '6M', '1Y', '5Y', 'ALL']);
  });

  it('pages the results through the chosen grid', () => {
    const g = gridById('2x2');
    expect(pageCount(10, g)).toBe(3);
    expect(pageSymbols(symbols, 0, g)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(pageSymbols(symbols, 2, g)).toEqual(['S9', 'S10']);
    expect(pageRange(1, 10, g)).toBe('5–8 of 10');
    expect(pageRange(0, 1, gridById('1x1'))).toBe('1 of 1');
    expect(pageCount(0, g)).toBe(1);
  });

  it('keeps the page in range when the grid or the results change', () => {
    expect(clampPage(5, 10, gridById('2x2'))).toBe(2);
    expect(clampPage(-1, 10, gridById('1x1'))).toBe(0);
  });

  it('draws a short last page in a smaller grid, keeping its orientation', () => {
    expect(shapeFor(gridById('2x2'), 4)).toEqual({ rows: 2, cols: 2 });
    expect(shapeFor(gridById('2x2'), 3)).toEqual({ rows: 1, cols: 3 });
    expect(shapeFor(gridById('2x2'), 2)).toEqual({ rows: 1, cols: 2 });
    expect(shapeFor(gridById('2x1'), 1)).toEqual({ rows: 1, cols: 1 });
    expect(shapeFor(gridById('2x1'), 2)).toEqual({ rows: 2, cols: 1 });
  });

  it('falls back to 2×2 for an unknown grid', () => {
    expect(gridById('9x9').id).toBe('2x2');
  });
});
