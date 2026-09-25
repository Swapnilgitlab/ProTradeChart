import { describe, expect, it } from 'vitest';
import { mergeQuotes, quoteTargets, rollingSlice, rowWindow, SMALL_LIST, type PriceLike } from './listWindow';

const symbols = (n: number) => Array.from({ length: n }, (_, i) => `binance:S${i}`);

describe('rowWindow', () => {
  it('covers the rows on screen plus the overscan either side', () => {
    // 35px rows, scrolled to row 100, a 350px viewport: rows 100–110 are on screen.
    expect(rowWindow(3500, 350, 35, 1000, 5)).toEqual({ start: 95, end: 116 });
  });

  it('clamps at both ends of the list', () => {
    expect(rowWindow(0, 350, 35, 1000, 5)).toEqual({ start: 0, end: 16 });
    expect(rowWindow(35 * 995, 350, 35, 1000, 5)).toEqual({ start: 990, end: 1000 });
  });

  it('covers a short list whole', () => {
    expect(rowWindow(0, 800, 35, 7, 5)).toEqual({ start: 0, end: 7 });
  });

  it('is empty for an empty list and safe with odd measurements', () => {
    expect(rowWindow(0, 800, 35, 0, 5)).toEqual({ start: 0, end: 0 });
    expect(rowWindow(-40, -10, 35, 10, 2)).toEqual({ start: 0, end: 3 });
    expect(rowWindow(0, 800, 0, 10, 2)).toEqual({ start: 0, end: 0 });
  });
});

describe('rollingSlice', () => {
  it('walks the list a slice at a time and wraps', () => {
    const items = [1, 2, 3, 4, 5];
    const a = rollingSlice(items, 0, 2);
    const b = rollingSlice(items, a.next, 2);
    const c = rollingSlice(items, b.next, 2);
    expect([a.slice, b.slice, c.slice]).toEqual([[1, 2], [3, 4], [5, 1]]);
    expect(c.next).toBe(1);
  });

  it('copes with a list that shrank under the cursor', () => {
    expect(rollingSlice([1, 2, 3], 7, 2)).toEqual({ slice: [2, 3], next: 0 });
  });

  it('returns everything when the slice covers the list', () => {
    expect(rollingSlice([1, 2], 1, 5)).toEqual({ slice: [1, 2], next: 0 });
    expect(rollingSlice([], 3, 5)).toEqual({ slice: [], next: 0 });
  });
});

describe('quoteTargets', () => {
  it('quotes a short list whole', () => {
    const all = symbols(SMALL_LIST);
    expect(quoteTargets(all, all.slice(0, 5), false, 0, 10).symbols).toEqual(all);
  });

  it('quotes only the visible rows of a long list', () => {
    const all = symbols(1000);
    const visible = all.slice(40, 70);
    expect(quoteTargets(all, visible, false, 0, 60)).toEqual({ symbols: visible, next: 0 });
  });

  it('walks the whole of a long list, beside the visible rows, while a price sort needs it', () => {
    const all = symbols(1000);
    const visible = all.slice(0, 30);
    const first = quoteTargets(all, visible, true, 0, 60);
    expect(first.symbols).toHaveLength(60); // the first chunk overlaps the visible rows
    const second = quoteTargets(all, visible, true, first.next, 60);
    expect(second.symbols).toHaveLength(90);
    expect(second.symbols).toContain('binance:S119');
    expect(second.next).toBe(120);
  });
});

describe('mergeQuotes', () => {
  const q = (price: number | null, changePercent: number | null = null): PriceLike => ({ price, changePercent });

  it('adds new prices and keeps prices for symbols that were not asked about', () => {
    const prev = new Map([['A', q(1)]]);
    const next = mergeQuotes(prev, new Map([['B', q(2)]]));
    expect([...next]).toEqual([
      ['A', q(1)],
      ['B', q(2)],
    ]);
  });

  it('never blanks a known price with a failed one', () => {
    const prev = new Map([['A', q(1, 0.5)]]);
    expect(mergeQuotes(prev, new Map([['A', q(null)]]))).toBe(prev);
  });

  it('records a failure for a symbol it knew nothing about', () => {
    const next = mergeQuotes(new Map(), new Map([['A', q(null)]]));
    expect(next.get('A')).toEqual(q(null));
  });

  it('returns the same map when nothing changed, so nothing re-renders', () => {
    const prev = new Map([['A', q(1, 0.5)]]);
    expect(mergeQuotes(prev, new Map([['A', q(1, 0.5)]]))).toBe(prev);
    expect(mergeQuotes(prev, new Map([['A', q(2, 0.5)]]))).not.toBe(prev);
  });
});
