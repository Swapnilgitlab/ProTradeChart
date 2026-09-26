import { describe, expect, it } from 'vitest';
import { applyFix, checkReadiness, historyBars, loadFrom, type ReadinessFacts } from './readiness';
import { normalizeSpec } from './spec';
import { fromTemplate } from './templates';

const facts = (over: Partial<ReadinessFacts> = {}): ReadinessFacts => ({
  providers: [
    { id: 'zerodha', usable: true },
    { id: 'dhan', usable: false },
  ],
  pythonReady: true,
  watchlists: ['Nifty 50'],
  today: '2026-09-26',
  ...over,
});

const item = (r: ReturnType<typeof checkReadiness>, field: string) => r.items.find((i) => i.field === field)!;

describe('checkReadiness', () => {
  it('is ready when the broker and Python are, and says what data is missing anyway', () => {
    const r = checkReadiness(fromTemplate('winners_100'), facts());
    expect(r.ready).toBe(true);
    expect(item(r, 'OHLC').status).toBe('available');
    expect(item(r, 'Market cap')).toMatchObject({ status: 'unavailable', blocking: false });
    expect(item(r, 'Sector').status).toBe('unavailable');
    expect(item(r, 'Point-in-time universe').detail).toContain('survivorship');
    expect(r.score).toBe(100);
  });

  it('blocks a market-cap filter and offers the traded-value alternative, applied only on request', () => {
    const spec = fromTemplate('winners_100');
    spec.universe.market_cap_min = 1e10;
    spec.universe.min_avg_traded_value = null;
    const r = checkReadiness(spec, facts());
    expect(r.ready).toBe(false);
    expect(item(r, 'Market cap')).toMatchObject({ status: 'unavailable', blocking: true, fix: { id: 'use_traded_value' } });
    const fixed = applyFix(spec, 'use_traded_value');
    expect(fixed.universe.market_cap_min).toBeNull();
    expect(fixed.universe.min_avg_traded_value).toBe(1e7);
    expect(spec.universe.market_cap_min).toBe(1e10);
    expect(checkReadiness(fixed, facts()).ready).toBe(true);
  });

  it('blocks when the broker or Python isn’t set up, or the watchlist doesn’t exist', () => {
    const spec = fromTemplate('winners_100');
    expect(checkReadiness(spec, facts({ providers: [{ id: 'zerodha', usable: false }] })).ready).toBe(false);
    expect(checkReadiness(spec, facts({ pythonReady: false, pythonMessage: 'No Python' })).items[0].detail).toBe('No Python');
    const listed = normalizeSpec({ ...spec, universe: { ...spec.universe, source: 'watchlist', watchlist: 'Gone' } });
    expect(item(checkReadiness(listed, facts()), 'Universe').blocking).toBe(true);
    const symbols = normalizeSpec({ ...spec, universe: { ...spec.universe, source: 'symbols', symbols: ['binance:BTCUSDT'] } });
    expect(item(checkReadiness(symbols, facts()), 'OHLC').blocking).toBe(true);
  });

  it('offers to drop the benchmark when its source isn’t set up, and the result still validates', () => {
    const spec = fromTemplate('winners_100');
    spec.benchmark = 'dhan:IDX:NIFTY500';
    const r = checkReadiness(spec, facts());
    expect(item(r, 'Index data')).toMatchObject({ status: 'unavailable', blocking: false, fix: { id: 'drop_benchmark' } });
    const dropped = applyFix(spec, 'drop_benchmark');
    expect(dropped.metrics.some((m) => m.startsWith('rs_'))).toBe(false);
    expect(() => normalizeSpec(dropped)).not.toThrow();
  });

  it('works out the history the engine will load', () => {
    const spec = fromTemplate('winners_100');
    // 252 bars of look-back plus a 252-bar max drawdown measured there (twice its window).
    expect(historyBars(spec)).toBe(252 + 504 + 5);
    expect(loadFrom(spec) < '2015-01-01').toBe(true);
  });
});
