import { describe, expect, it } from 'vitest';
import engineResult from './fixtures/engine-result.json';
import { parseStudyResult } from './result';
import type { Cell } from '../python/results';
import { beforeAfterWindows, eventColumns, eventGrid, headline, liquidityBuckets, measureColumns, median, medianGap, sortRows } from './views';

const result = () => parseStudyResult(structuredClone(engineResult))!;

describe('result views', () => {
  it('pick the event table’s columns for an observation point', () => {
    const cols = eventColumns(result(), -63).map((c) => c.key);
    expect(cols.slice(0, 4)).toEqual(['symbol', 'name', 'event_date', 'event_value']);
    expect(cols).toContain('rsi_14@-63');
    expect(cols).not.toContain('rsi_14@0');
    expect(cols).toContain('fwd_return_63');
    expect(eventColumns(result(), -63).find((c) => c.key === 'rvol_20@-63')?.unit).toBe('multiple');
  });

  it('pair observation points either side of the event', () => {
    expect(beforeAfterWindows(result())).toEqual([63, 126]);
  });

  it('bucket events by liquidity, not by a market cap it doesn’t have', () => {
    const buckets = liquidityBuckets(result());
    expect(buckets.reduce((n, b) => n + b.events, 0)).toBe(1);
    expect(buckets[0].forward).toHaveLength(2);
  });

  it('lay out one event’s measurements, and small sums', () => {
    const r = result();
    const grid = eventGrid(r, r.events.rows[0]);
    expect(grid.map((g) => g.metric)).toEqual(r.spec.metrics);
    expect(grid[0].values).toHaveLength(r.offsets.length);
    expect(median([3, null, 1, 2, 'x'])).toBe(2);
    expect(median([])).toBeNull();
    expect(medianGap({ median: 3 } as never, { median: 1 } as never)).toBe(2);
    expect(medianGap(null, { median: 1 } as never)).toBeNull();
    expect(headline(r)).toBe('1 event · 1 unique stock · 2019');
  });
});

describe('measure columns and sorting', () => {
  it('give each measure its value column, with where its status is, and an episode its start date', () => {
    const r = result();
    const cols = measureColumns(r);
    expect(cols.map((c) => c.key)).toEqual(['measure_0', 'measure_1', 'measure_1_from']);
    expect(cols[0]).toMatchObject({ unit: 'share', measure: { index: 0, statusIndex: r.events.columns.indexOf('measure_0_status') } });
    expect(cols[1].unit).toBe('bars');
    expect(cols[2].unit).toBe('date');
    expect(eventColumns(r, 0).map((c) => c.key)).toContain('measure_1_from');
  });

  it('sort rows by a column either way, blanks always last, and keep the engine’s order without a sort', () => {
    const r = result();
    const col = r.events.columns.length;
    const rows: Cell[][] = [3, null, 1, 2].map((v, i) => [...r.events.rows[0].slice(0, col - 1), i === 1 ? null : v]);
    const data = { ...r, events: { ...r.events, columns: [...r.events.columns.slice(0, col - 1), 'x'], rows } };
    const values = (dir: 1 | -1) => sortRows(data, { key: 'x', dir }).map(({ row }) => row[col - 1]);
    expect(values(1)).toEqual([1, 2, 3, null]);
    expect(values(-1)).toEqual([3, 2, 1, null]);
    expect(sortRows(data, null).map(({ i }) => i)).toEqual([0, 1, 2, 3]);
    expect(sortRows(data, { key: 'nope', dir: 1 }).map(({ i }) => i)).toEqual([0, 1, 2, 3]);
  });
});
