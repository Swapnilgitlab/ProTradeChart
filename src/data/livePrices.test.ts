import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLivePrice, publishLivePrice, subscribeLivePrice } from './livePrices';

// The store is module state, so each test uses a symbol of its own.
let n = 0;
const fresh = () => `test:SYM${n++}`;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('live prices', () => {
  it('remembers the latest price of a symbol, with its time', () => {
    const s = fresh();
    expect(getLivePrice(s)).toBeUndefined();
    publishLivePrice(s, 10, 111);
    publishLivePrice(s, 12, 222);
    expect(getLivePrice(s)).toEqual({ price: 12, at: 222 });
  });

  it('ignores a price that is not a number', () => {
    const s = fresh();
    publishLivePrice(s, Number.NaN);
    publishLivePrice(s, Number.POSITIVE_INFINITY);
    expect(getLivePrice(s)).toBeUndefined();
  });

  it('tells a subscriber once for a burst of ticks, and lets it read the newest', () => {
    const s = fresh();
    const seen: (number | undefined)[] = [];
    subscribeLivePrice(s, () => seen.push(getLivePrice(s)?.price));
    publishLivePrice(s, 1);
    publishLivePrice(s, 2);
    publishLivePrice(s, 3);
    expect(seen).toEqual([]); // not before the pause
    vi.advanceTimersByTime(300);
    expect(seen).toEqual([3]);
  });

  it('says nothing when the price did not change', () => {
    const s = fresh();
    const notify = vi.fn();
    subscribeLivePrice(s, notify);
    publishLivePrice(s, 5);
    vi.advanceTimersByTime(300);
    publishLivePrice(s, 5);
    vi.advanceTimersByTime(300);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('tells only the subscribers of that symbol, and stops after they leave', () => {
    const a = fresh();
    const b = fresh();
    const forA = vi.fn();
    const forB = vi.fn();
    const stopA = subscribeLivePrice(a, forA);
    subscribeLivePrice(b, forB);

    publishLivePrice(a, 1);
    vi.advanceTimersByTime(300);
    expect(forA).toHaveBeenCalledTimes(1);
    expect(forB).not.toHaveBeenCalled();

    stopA();
    publishLivePrice(a, 2);
    vi.advanceTimersByTime(300);
    expect(forA).toHaveBeenCalledTimes(1);
    expect(getLivePrice(a)?.price).toBe(2); // still kept for whoever subscribes next
  });

  it('keeps a price that arrived while nobody was watching', () => {
    const s = fresh();
    publishLivePrice(s, 7);
    expect(vi.getTimerCount()).toBe(0); // no timer is spent on a symbol nobody shows
    expect(getLivePrice(s)?.price).toBe(7);
  });
});
