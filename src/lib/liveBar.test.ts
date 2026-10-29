import { describe, expect, it } from 'vitest';
import { bucketFor, LiveBarBuilder, resolveTickTime, sessionOpenForExchange } from './liveBar';
import { localMidnight } from './timeframes';

const MIN = 60_000;
// 2024-01-02 (a Tuesday) 09:15 IST is 03:45 UTC.
const OPEN_0915 = Date.parse('2024-01-02T03:45:00Z');
const at = (minutesAfterOpen: number, seconds = 0) => OPEN_0915 + minutesAfterOpen * MIN + seconds * 1000;
const tick = (ltp: number, volume: number | null = null) => ({ ltp, ltt: null, volume });
const M5 = { kind: 'minutes', minutes: 5 } as const;
const OPEN = sessionOpenForExchange('NSE');

describe('resolveTickTime', () => {
  const now = Date.parse('2027-01-15T06:00:00Z');
  const nowS = now / 1000;

  it('trusts a plain Unix timestamp that agrees with the clock', () => {
    expect(resolveTickTime(nowS - 30, now)).toBe((nowS - 30) * 1000);
  });

  it('recognises a 1980-based epoch by which reading lands near now', () => {
    expect(resolveTickTime(nowS - 30 - 315_532_800, now)).toBe((nowS - 30) * 1000);
  });

  it('recognises an IST wall clock written as if it were UTC', () => {
    expect(resolveTickTime(nowS - 30 + 19_800, now)).toBe((nowS - 30) * 1000);
  });

  it('falls back to arrival time when the timestamp fits no reading, or is missing', () => {
    expect(resolveTickTime(12345, now)).toBe(now);
    expect(resolveTickTime(null, now)).toBe(now);
    expect(resolveTickTime(Number.NaN, now)).toBe(now);
  });
});

describe('bucketFor', () => {
  it('anchors intraday bars to the session open, not to round clock times', () => {
    // 09:17 IST falls in the 09:15 bar; 09:20:00 starts the next.
    expect(bucketFor(M5, at(2), OPEN)!.time).toBe(OPEN_0915);
    expect(bucketFor(M5, at(5), OPEN)!.time).toBe(at(5));
    expect(bucketFor({ kind: 'minutes', minutes: 25 }, at(26), OPEN)!.time).toBe(at(25));
    expect(bucketFor({ kind: 'minutes', minutes: 60 }, at(75), OPEN)!.time).toBe(at(60));
  });

  it('ignores ticks before the session opens (the pre-open auction)', () => {
    expect(bucketFor(M5, at(-10), OPEN)).toBeNull();
  });

  it('gives each IST day its own bars even across the UTC date line', () => {
    const lateNextDay = Date.parse('2024-01-03T09:50:00Z'); // 15:20 IST on 3 Jan
    const bucket = bucketFor(M5, lateNextDay, OPEN)!;
    expect(new Date(bucket.time).toISOString()).toBe('2024-01-03T09:50:00.000Z');
  });

  it('stamps daily bars at local midnight of the IST date, and groups weeks and months', () => {
    expect(bucketFor({ kind: 'day' }, at(10), OPEN)!.time).toBe(localMidnight('2024-01-02'));
    const wed = bucketFor({ kind: 'week' }, Date.parse('2024-01-03T05:00:00Z'), OPEN)!;
    const fri = bucketFor({ kind: 'week' }, Date.parse('2024-01-05T05:00:00Z'), OPEN)!;
    const nextMon = bucketFor({ kind: 'week' }, Date.parse('2024-01-08T05:00:00Z'), OPEN)!;
    expect(wed.key).toBe(fri.key);
    expect(nextMon.key).not.toBe(wed.key);
    expect(bucketFor({ kind: 'month' }, Date.parse('2024-01-31T05:00:00Z'), OPEN)!.key).toBe('2024-01');
    expect(bucketFor({ kind: 'month' }, Date.parse('2024-02-01T05:00:00Z'), OPEN)!.key).toBe('2024-02');
  });
});

describe('LiveBarBuilder', () => {
  const build = () => new LiveBarBuilder({ tf: M5, sessionOpenMin: OPEN, seed: null });

  it('opens a bar on the first tick and folds later ticks in', () => {
    const b = build();
    expect(b.onTick(tick(100), at(0, 1))).toMatchObject({ time: OPEN_0915, open: 100, high: 100, low: 100, close: 100 });
    b.onTick(tick(105), at(1));
    b.onTick(tick(98), at(2));
    expect(b.onTick(tick(101), at(3))).toMatchObject({ time: OPEN_0915, open: 100, high: 105, low: 98, close: 101 });
  });

  it('starts a fresh bar when the bucket rolls over', () => {
    const b = build();
    b.onTick(tick(100), at(1));
    const next = b.onTick(tick(110), at(5, 1))!;
    expect(next).toMatchObject({ time: at(5), open: 110, high: 110, low: 110, close: 110 });
  });

  it('ignores ticks before the open and nonsense prices', () => {
    const b = build();
    expect(b.onTick(tick(100), at(-5))).toBeNull();
    expect(b.onTick(tick(0), at(1))).toBeNull();
    expect(b.onTick(tick(Number.NaN), at(1))).toBeNull();
  });

  it('adds live volume to the seeded bar using the change in the days cumulative volume', () => {
    const seed = { time: OPEN_0915, open: 100, high: 102, low: 99, close: 101, volume: 5000 };
    const b = new LiveBarBuilder({ tf: M5, sessionOpenMin: OPEN, seed });
    // The first quote only establishes the baseline: nothing to add yet.
    expect(b.onTick(tick(101, 1_000_000), at(2))!.volume).toBe(5000);
    // 700 more shares trade afterwards.
    const bar = b.onTick(tick(103, 1_000_700), at(3))!;
    expect(bar).toMatchObject({ open: 100, high: 103, low: 99, close: 103, volume: 5700 });
  });

  it('continues a seeded bar rather than opening a duplicate', () => {
    const seed = { time: OPEN_0915, open: 100, high: 102, low: 99, close: 101 };
    const b = new LiveBarBuilder({ tf: M5, sessionOpenMin: OPEN, seed });
    const bar = b.onTick(tick(103), at(2))!;
    expect(bar.time).toBe(OPEN_0915);
    expect(bar.open).toBe(100);
  });

  it('starts a new bar when the seed belongs to an earlier bucket', () => {
    const seed = { time: OPEN_0915, open: 100, high: 102, low: 99, close: 101 };
    const b = new LiveBarBuilder({ tf: M5, sessionOpenMin: OPEN, seed });
    expect(b.onTick(tick(120), at(6))!.time).toBe(at(5));
  });

  it('tracks a new bars volume from zero at its first tick', () => {
    const b = build();
    b.onTick(tick(100, 1_000_000), at(1));
    b.onTick(tick(101, 1_000_400), at(2));
    const rolled = b.onTick(tick(102, 1_000_900), at(6))!;
    expect(rolled.volume).toBe(0);
    expect(b.onTick(tick(103, 1_001_200), at(7))!.volume).toBe(300);
  });

  it('uses the feeds figure directly as the volume of a daily bar', () => {
    const b = new LiveBarBuilder({ tf: { kind: 'day' }, sessionOpenMin: OPEN, seed: null });
    b.onTick(tick(100, 2_000_000), at(1));
    expect(b.onTick(tick(101, 2_500_000), at(2))!.volume).toBe(2_500_000);
  });

  it('continues a seeded daily bar even when its local-midnight stamp is on the previous UTC day', () => {
    const seed = { time: localMidnight('2024-01-02'), open: 100, high: 102, low: 99, close: 101, volume: 10 };
    const b = new LiveBarBuilder({ tf: { kind: 'day' }, sessionOpenMin: OPEN, seed });
    const bar = b.onTick(tick(105), at(30))!;
    expect(bar.time).toBe(localMidnight('2024-01-02'));
    expect(bar.open).toBe(100);
    expect(bar.high).toBe(105);
  });

  it('gives a daily bar the polled quote’s own day range, which samples alone would miss', () => {
    const b = new LiveBarBuilder({ tf: { kind: 'day' }, sessionOpenMin: OPEN, seed: null });
    const quote = (ltp: number, dayOpen: number, dayHigh: number, dayLow: number) => ({ ltp, ltt: null, volume: null, dayOpen, dayHigh, dayLow });
    expect(b.onTick(quote(101, 98, 104, 97), at(30))).toMatchObject({ open: 98, high: 104, low: 97, close: 101 });
    expect(b.onTick(quote(103, 98, 106, 96), at(60))).toMatchObject({ open: 98, high: 106, low: 96, close: 103 });
  });

  it('never lets a day range reshape an intraday bar', () => {
    const b = build();
    const bar = b.onTick({ ltp: 101, ltt: null, volume: null, dayOpen: 90, dayHigh: 110, dayLow: 80 }, at(1))!;
    expect(bar).toMatchObject({ open: 101, high: 101, low: 101, close: 101 });
  });

  it('uses the tick timestamp when it agrees with the clock', () => {
    const b = build();
    // Traded at 09:19 but delivered at 09:23 (a delayed link): the trade belongs to the 09:15 bar.
    const bar = b.onTick({ ltp: 100, ltt: at(4) / 1000, volume: null }, at(8))!;
    expect(bar.time).toBe(OPEN_0915);
    // Whereas arrival time alone would have put it in the 09:20 bar.
    expect(build().onTick(tick(100), at(8))!.time).toBe(at(5));
  });
});

describe('sessionOpenForExchange', () => {
  it('opens equities, indices and equity derivatives at 09:15 IST', () => {
    for (const exchange of ['NSE', 'BSE', 'NFO', 'BFO']) expect(sessionOpenForExchange(exchange)).toBe(555);
  });

  it('opens currency and commodity markets at 09:00 IST', () => {
    for (const exchange of ['CDS', 'BCD', 'MCX']) expect(sessionOpenForExchange(exchange)).toBe(540);
  });
});
