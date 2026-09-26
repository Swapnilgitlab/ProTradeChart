import { describe, expect, it } from 'vitest';
import engineResult from './fixtures/engine-result.json';
import { parseStudyResult } from './result';
import { beforeAfterWindows, eventColumns, eventGrid, headline, liquidityBuckets, median, medianGap } from './views';

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
