import { describe, expect, it } from 'vitest';
import { fromPreset } from './presets';
import { screenReadiness } from './readiness';
import type { ScreenSpec } from './spec';

const zerodha = [{ id: 'zerodha', usable: true }];
const facts = { providers: zerodha, pythonReady: true, watchlists: ['Swing'], estimate: null };

function withUniverse(patch: Partial<ScreenSpec['universe']>): ScreenSpec {
  const spec = fromPreset('near_high');
  return { ...spec, universe: { ...spec.universe, ...patch } };
}

describe('screenReadiness', () => {
  it('is ready with Python and the broker set up', () => {
    expect(screenReadiness(fromPreset('near_high'), facts).ready).toBe(true);
  });

  it('is blocked without Python, saying why', () => {
    const r = screenReadiness(fromPreset('near_high'), { ...facts, pythonReady: false, pythonMessage: 'No Python found.' });
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.blocking)?.text).toBe('No Python found.');
  });

  it('is blocked when the universe’s broker is not set up', () => {
    const r = screenReadiness(withUniverse({ provider: 'zerodha' }), { ...facts, providers: [{ id: 'zerodha', usable: false }] });
    expect(r.ready).toBe(false);
    expect(r.checks.some((c) => c.text.includes('Zerodha isn\'t set up'))).toBe(true);
  });

  it('refuses sources the engine cannot read', () => {
    const r = screenReadiness(withUniverse({ source: 'symbols', symbols: ['binance:BTCUSDT'] }), facts);
    expect(r.ready).toBe(false);
    expect(r.checks.some((c) => c.text.includes('not binance'))).toBe(true);
  });

  it('needs the named watchlist to exist', () => {
    expect(screenReadiness(withUniverse({ source: 'watchlist', watchlist: 'swing' }), facts).ready).toBe(true);
    expect(screenReadiness(withUniverse({ source: 'watchlist', watchlist: 'Gone' }), facts).ready).toBe(false);
  });

  it('prices the run and offers a trial when it would be long', () => {
    const estimate = { symbols: 2000, stored: 0, requests: 2000, quoteRequests: 0, seconds: 700, listingsSkipped: 0 };
    const long = screenReadiness(fromPreset('near_high'), { ...facts, estimate });
    expect(long.offerTrial).toBe(true);
    expect(long.checks[long.checks.length - 1]?.text).toContain('2,000 broker requests, about 12 min');
    const cached = screenReadiness(fromPreset('near_high'), { ...facts, estimate: { ...estimate, stored: 2000, requests: 0, seconds: 0 } });
    expect(cached.offerTrial).toBe(false);
    expect(cached.checks[cached.checks.length - 1]?.text).toContain('nothing to fetch');
    const empty = screenReadiness(fromPreset('near_high'), { ...facts, estimate: { ...estimate, symbols: 0 } });
    expect(empty.ready).toBe(false);
  });

  it('prices an already-synced universe at the quote top-up, not a broker request each', () => {
    const estimate = { symbols: 2000, stored: 2000, requests: 0, quoteRequests: 1, seconds: 1.1, listingsSkipped: 0 };
    const r = screenReadiness(fromPreset('near_high'), { ...facts, estimate });
    const text = r.checks[r.checks.length - 1]?.text ?? '';
    expect(text).toContain('1 quick quote check');
    expect(text).not.toContain('nothing to fetch');
    expect(r.offerTrial).toBe(false);
  });
});
