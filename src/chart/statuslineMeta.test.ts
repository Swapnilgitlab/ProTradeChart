import { describe, expect, it } from 'vitest';
import { withoutDataSource } from './statuslineMeta';

describe('withoutDataSource', () => {
  it('drops the data source and keeps the timeframe', () => {
    expect(withoutDataSource('· ZERODHA · 1D')).toBe('· 1D');
    expect(withoutDataSource('· BINANCE · 5')).toBe('· 5');
    expect(withoutDataSource('· IMPORTED · 15m')).toBe('· 15m');
  });

  it('leaves a line that already has no source alone', () => {
    expect(withoutDataSource('· 1D')).toBe('· 1D');
    expect(withoutDataSource('')).toBe('');
  });

  it('is a fixed point, so watching the line it rewrites cannot loop', () => {
    const once = withoutDataSource('· ZERODHA · 1D');
    expect(withoutDataSource(once)).toBe(once);
  });

  it('keeps every part after the source', () => {
    expect(withoutDataSource('· ZERODHA · 1D · RTH')).toBe('· 1D · RTH');
  });
});
