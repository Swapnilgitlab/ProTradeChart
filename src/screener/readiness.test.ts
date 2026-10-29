import { describe, expect, it } from 'vitest';
import { fromPreset } from './presets';
import { screenReadiness } from './readiness';
import type { ScreenSpec } from './spec';

const india = [{ id: 'india', usable: true, label: 'Zerodha' }];
const facts = { providers: india, pythonReady: true, watchlists: ['Swing'], estimate: null };

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
    const r = screenReadiness(withUniverse({ provider: 'india' }), { ...facts, providers: [{ id: 'india', usable: false, label: 'Zerodha' }] });
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
    expect(long.checks.map((c) => c.text).join(' | ')).toContain('2,000 broker requests, about 12 min');
    const cached = screenReadiness(fromPreset('near_high'), { ...facts, estimate: { ...estimate, stored: 2000, requests: 0, seconds: 0 } });
    expect(cached.offerTrial).toBe(false);
    expect(cached.checks[cached.checks.length - 1]?.text).toContain('nothing to fetch');
    const empty = screenReadiness(fromPreset('near_high'), { ...facts, estimate: { ...estimate, symbols: 0 } });
    expect(empty.ready).toBe(false);
  });

  it('says when today’s quote decides the screen, and when the broker’s pace bounds it', () => {
    const estimate = { symbols: 2000, stored: 0, requests: 2000, quoteRequests: 0, seconds: 700, listingsSkipped: 0 };
    const texts = (spec: ScreenSpec) => screenReadiness(spec, { ...facts, estimate }).checks.map((c) => c.text).join(' | ');
    const quick = { ...fromPreset('near_high'), filters: [{ left: 'return_1', op: '>' as const, right: 0.03 }], columns: ['close'] };
    expect(texts(quick)).toContain('one quick quote check');
    expect(texts(quick)).not.toContain('broker requests');
    expect(screenReadiness(quick, { ...facts, estimate }).offerTrial).toBe(false);
    const mixed = { ...quick, filters: [...quick.filters, { left: 'close', op: '>' as const, right: 'sma_200' }] };
    expect(texts(mixed)).toContain('rules stocks out first');
    const slow = { ...quick, filters: [{ left: 'close', op: '>' as const, right: 'sma_200' }] };
    expect(texts(slow)).toContain('Keep the market loaded');
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
