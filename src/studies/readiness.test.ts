import { describe, expect, it } from 'vitest';
import { applyFix, checkReadiness, formatDuration, historyBars, loadFrom, TRIAL_SYMBOLS, type ReadinessFacts } from './readiness';
import { normalizeSpec } from './spec';
import { fromTemplate } from './templates';

const facts = (over: Partial<ReadinessFacts> = {}): ReadinessFacts => ({
  providers: [
    { id: 'india', usable: true },
    { id: 'binance', usable: false },
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
    expect(checkReadiness(spec, facts({ providers: [{ id: 'india', usable: false }] })).ready).toBe(false);
    expect(checkReadiness(spec, facts({ pythonReady: false, pythonMessage: 'No Python' })).items[0].detail).toBe('No Python');
    const listed = normalizeSpec({ ...spec, universe: { ...spec.universe, source: 'watchlist', watchlist: 'Gone' } });
    expect(item(checkReadiness(listed, facts()), 'Universe').blocking).toBe(true);
    const symbols = normalizeSpec({ ...spec, universe: { ...spec.universe, source: 'symbols', symbols: ['binance:BTCUSDT'] } });
    expect(item(checkReadiness(symbols, facts()), 'OHLC').blocking).toBe(true);
  });

  it('offers to drop the benchmark when its source isn’t set up, and the result still validates', () => {
    const spec = fromTemplate('winners_100');
    spec.benchmark = 'binance:BTCUSDT';
    const r = checkReadiness(spec, facts());
    expect(item(r, 'Index data')).toMatchObject({ status: 'unavailable', blocking: false, fix: { id: 'drop_benchmark' } });
    const dropped = applyFix(spec, 'drop_benchmark');
    expect(dropped.metrics.some((m) => m.startsWith('rs_'))).toBe(false);
    expect(() => normalizeSpec(dropped)).not.toThrow();
  });

  it('drops a measure that needs the benchmark along with it', () => {
    const spec = normalizeSpec({
      ...fromTemplate('winners_100'),
      measures: [
        { stat: 'mean', feature: 'rs_126', window: { start: { offset: -63 }, end: { offset: 0 } } },
        { stat: 'return', window: { start: { offset: -63 }, end: { offset: 0 } } },
      ],
    });
    const dropped = applyFix(spec, 'drop_benchmark');
    expect(dropped.measures.map((m) => m.stat)).toEqual(['return']);
    expect(() => normalizeSpec(dropped)).not.toThrow();
  });

  it('loads enough history for the furthest window a measure reads', () => {
    const base = fromTemplate('winners_100');
    const deep = normalizeSpec({ ...base, measures: [{ stat: 'return', window: { start: { offset: -600 }, end: { offset: 0 } } }] });
    expect(historyBars(deep)).toBe(600 + 504 + 5);
    const found = normalizeSpec({ ...base, measures: [{ stat: 'length', window: { start: { find: 'lowest', feature: 'close', within: 700 }, end: { offset: 0 } } }] });
    expect(historyBars(found)).toBe(700 + 504 + 5);
  });

  it('works out the history the engine will load', () => {
    const spec = fromTemplate('winners_100');
    // 252 bars of look-back plus a 252-bar max drawdown measured there (twice its window).
    expect(historyBars(spec)).toBe(252 + 504 + 5);
    expect(loadFrom(spec) < '2015-01-01').toBe(true);
  });

  it('says what the data will cost and offers a trial run when it is long', () => {
    const spec = fromTemplate('winners_100');
    spec.universe.exchanges = ['NSE', 'BSE'];
    const r = checkReadiness(spec, facts({ estimate: { symbols: 4200, stored: 200, requests: 4000, quoteRequests: 0, seconds: 1400, listingsSkipped: 9000 } }));
    const cost = item(r, 'Data to load');
    expect(cost.status).toBe('warning');
    expect(cost.detail).toContain('4,200 symbols');
    expect(cost.detail).toContain('9,000 other listings left out');
    expect(cost.detail).toContain('200 already loaded');
    expect(cost.detail).toContain('about 23 min');
    expect(cost.fix?.id).toBe('trial_run');
    expect(applyFix(spec, 'trial_run').universe.max_symbols).toBe(TRIAL_SYMBOLS);
    expect(r.notes.join(' ')).toContain('BSE lists several times as many');
    expect(r.ready).toBe(true);
  });

  it('calls a quick load quick and an empty universe a problem', () => {
    const quick = checkReadiness(
      fromTemplate('winners_100'),
      facts({ estimate: { symbols: 2000, stored: 2000, requests: 0, quoteRequests: 0, seconds: 0, listingsSkipped: 0 } }),
    );
    expect(item(quick, 'Data to load')).toMatchObject({ status: 'available', fix: undefined });
    expect(item(quick, 'Data to load').detail).toContain('nothing to fetch');
    const empty = checkReadiness(
      fromTemplate('winners_100'),
      facts({ estimate: { symbols: 0, stored: 0, requests: 0, quoteRequests: 0, seconds: 0, listingsSkipped: 12 } }),
    );
    expect(empty.ready).toBe(false);
  });

  it('prices an already-synced universe at the quote top-up, not a broker request each', () => {
    const r = checkReadiness(
      fromTemplate('winners_100'),
      facts({ estimate: { symbols: 2000, stored: 2000, requests: 0, quoteRequests: 1, seconds: 1.1, listingsSkipped: 0 } }),
    );
    const detail = item(r, 'Data to load').detail;
    expect(detail).toContain('1 quick quote check');
    expect(detail).not.toContain('nothing to fetch');
    expect(detail).not.toContain('broker request');

    const mixed = checkReadiness(
      fromTemplate('winners_100'),
      facts({ estimate: { symbols: 2000, stored: 1990, requests: 10, quoteRequests: 1, seconds: 4.6, listingsSkipped: 0 } }),
    );
    const mixedDetail = item(mixed, 'Data to load').detail;
    expect(mixedDetail).toContain('10 broker requests');
    expect(mixedDetail).toContain('1 quick quote check');
  });

  it('writes durations as people read them', () => {
    expect(formatDuration(12)).toBe('about 12 s');
    expect(formatDuration(725)).toBe('about 12 min');
    expect(formatDuration(4800)).toBe('about 1 h 20 min');
  });
});
