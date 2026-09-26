import { describe, expect, it } from 'vitest';
import { LIVE_TTL_MS, withFreshQuotes, withLivePrice, type TimedQuote } from './tabQuote';

const quote = (price: number | null, changePercent: number | null, at = 1000): TimedQuote => ({ price, changePercent, at });

describe('merging a poll into the tab quotes', () => {
  it('stamps each priced result with the time of the poll', () => {
    const next = withFreshQuotes(new Map(), new Map([['a', { price: 10, changePercent: 1 }]]), 5000);
    expect(next.get('a')).toEqual({ price: 10, changePercent: 1, at: 5000 });
  });

  it('keeps the quote a symbol had when the poll came back without a price', () => {
    const prev = new Map([['a', quote(10, 1)]]);
    const next = withFreshQuotes(prev, new Map([['a', { price: null, changePercent: null }]]), 9000);
    expect(next).toBe(prev);
    expect(next.get('a')?.at).toBe(1000);
  });

  it('adds a symbol without touching the others', () => {
    const prev = new Map([['a', quote(10, 1)]]);
    const next = withFreshQuotes(prev, new Map([['b', { price: 20, changePercent: -2 }]]), 3000);
    expect(next.get('a')).toEqual(quote(10, 1));
    expect(next.get('b')).toEqual(quote(20, -2, 3000));
    expect(prev.has('b')).toBe(false); // the old map is not mutated
  });
});

describe('the price to show', () => {
  it('is the polled quote when nothing is streaming', () => {
    expect(withLivePrice(quote(100, 2), undefined, 2000)).toEqual({ price: 100, changePercent: 2 });
  });

  it('is nothing at all when there is neither', () => {
    expect(withLivePrice(undefined, undefined, 2000)).toEqual({ price: null, changePercent: null });
  });

  it('moves to the streamed price when that is newer, re-measuring the change from the previous close', () => {
    // 102 up 2% means the previous close was 100; a streamed 105 is +5% on that.
    const shown = withLivePrice(quote(102, 2, 1000), { price: 105, at: 1500 }, 2000);
    expect(shown.price).toBe(105);
    expect(shown.changePercent).toBeCloseTo(5, 10);
  });

  it('follows the price down through the previous close too', () => {
    const shown = withLivePrice(quote(98, -2, 1000), { price: 90, at: 1500 }, 2000);
    expect(shown.changePercent).toBeCloseTo(-10, 10);
  });

  it('trusts a poll that is newer than the last streamed price', () => {
    expect(withLivePrice(quote(100, 2, 3000), { price: 105, at: 1500 }, 4000)).toEqual({ price: 100, changePercent: 2 });
  });

  it('shows only the price when the poll had no change to measure from', () => {
    expect(withLivePrice(quote(100, null), { price: 105, at: 1500 }, 2000)).toEqual({ price: 105, changePercent: null });
    // A change of −100% has no previous close to recover either.
    expect(withLivePrice(quote(0, -100), { price: 5, at: 1500 }, 2000)).toEqual({ price: 5, changePercent: null });
  });

  it('shows a streamed price before the first poll lands, but not a stale one', () => {
    expect(withLivePrice(undefined, { price: 50, at: 1000 }, 1000 + 5000)).toEqual({ price: 50, changePercent: null });
    expect(withLivePrice(undefined, { price: 50, at: 1000 }, 1000 + LIVE_TTL_MS + 1)).toEqual({ price: null, changePercent: null });
    expect(withLivePrice(quote(null, null), { price: 50, at: 1000 }, 1000 + LIVE_TTL_MS + 1)).toEqual({ price: null, changePercent: null });
  });

  it('ignores a streamed price that is not a number', () => {
    expect(withLivePrice(quote(100, 2), { price: Number.NaN, at: 9999 }, 10000)).toEqual({ price: 100, changePercent: 2 });
  });
});
