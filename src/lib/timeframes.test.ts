import { describe, expect, it } from 'vitest';
import type { OHLCV } from '@luxalgo/vela';
import {
  exchangeDayKey,
  localMidnight,
  parseTimeframe,
  resampleCalendar,
  resampleIntraday,
  resampleTo,
  timeframeToString,
  toBrokerPlan,
  toFyersPlan,
  toKitePlan,
} from './timeframes';

const utc = exchangeDayKey(0);
const t = (iso: string) => Date.parse(iso);
const bar = (iso: string, o: number, h: number, l: number, c: number, v?: number): OHLCV => ({
  time: t(iso),
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
});

describe('parseTimeframe', () => {
  it('reads minute, hour, day, week and month spellings', () => {
    expect(parseTimeframe('5')).toEqual({ kind: 'minutes', minutes: 5 });
    expect(parseTimeframe('240')).toEqual({ kind: 'minutes', minutes: 240 });
    expect(parseTimeframe('4H')).toEqual({ kind: 'minutes', minutes: 240 });
    expect(parseTimeframe('D')).toEqual({ kind: 'day' });
    expect(parseTimeframe('1D')).toEqual({ kind: 'day' });
    expect(parseTimeframe('W')).toEqual({ kind: 'week' });
    expect(parseTimeframe('1M')).toEqual({ kind: 'month' });
    expect(parseTimeframe('M')).toEqual({ kind: 'month' });
  });

  it('rejects things the app cannot serve', () => {
    expect(parseTimeframe('0')).toBeNull();
    expect(parseTimeframe('1S')).toBeNull();
    expect(parseTimeframe('2W')).toBeNull();
    expect(parseTimeframe('')).toBeNull();
    expect(parseTimeframe('abc')).toBeNull();
  });

  it('round-trips through timeframeToString', () => {
    for (const tf of ['1', '60', 'D', 'W', 'M']) {
      expect(timeframeToString(parseTimeframe(tf)!)).toBe(tf);
    }
  });
});

describe('resampleIntraday', () => {
  // Two sessions of 5 hourly bars each (09:00–13:00 UTC).
  const hourly: OHLCV[] = [
    ...[9, 10, 11, 12, 13].map((h, i) => bar(`2024-01-02T${String(h).padStart(2, '0')}:00:00Z`, 10 + i, 20 + i, 5 + i, 11 + i, 100)),
    ...[9, 10, 11, 12, 13].map((h, i) => bar(`2024-01-03T${String(h).padStart(2, '0')}:00:00Z`, 30 + i, 40 + i, 25 + i, 31 + i, 100)),
  ];

  it('groups within each day and restarts at every session open', () => {
    const out = resampleIntraday(hourly, 2, utc);
    // 5 bars/day at groupSize 2 → [2,2,1] per day, never spanning midnight.
    expect(out).toHaveLength(6);
    expect(out[0].time).toBe(t('2024-01-02T09:00:00Z'));
    expect(out[2].time).toBe(t('2024-01-02T13:00:00Z')); // the lone last bar of day 1
    expect(out[3].time).toBe(t('2024-01-03T09:00:00Z')); // day 2 starts fresh
  });

  it('merges OHLCV correctly', () => {
    const [first] = resampleIntraday(hourly, 2, utc);
    expect(first).toEqual({ time: t('2024-01-02T09:00:00Z'), open: 10, high: 21, low: 5, close: 12, volume: 200 });
  });

  it('is a no-op for a group size of 1', () => {
    expect(resampleIntraday(hourly, 1, utc)).toBe(hourly);
  });

  it('respects the exchange timezone when deciding where a day begins', () => {
    // 19:00 UTC on Jan 2 is 00:30 on Jan 3 in IST (+5:30) — a new trading day.
    const ist = exchangeDayKey(19800);
    const bars = [bar('2024-01-02T17:00:00Z', 1, 1, 1, 1), bar('2024-01-02T19:00:00Z', 2, 2, 2, 2)];
    expect(resampleIntraday(bars, 2, ist)).toHaveLength(2);
    expect(resampleIntraday(bars, 2, utc)).toHaveLength(1);
  });

  it('leaves volume undefined when no bar carried any', () => {
    const [b] = resampleIntraday([bar('2024-01-02T09:00:00Z', 1, 2, 1, 2), bar('2024-01-02T10:00:00Z', 2, 3, 2, 3)], 2, utc);
    expect(b.volume).toBeUndefined();
  });
});

describe('resampleCalendar', () => {
  const daily = [
    bar('2024-01-01T00:00:00Z', 1, 5, 1, 4, 10), // Mon
    bar('2024-01-02T00:00:00Z', 4, 9, 3, 8, 10),
    bar('2024-01-05T00:00:00Z', 8, 8, 2, 3, 10), // Fri
    bar('2024-01-08T00:00:00Z', 3, 4, 3, 4, 10), // next Mon
    bar('2024-02-01T00:00:00Z', 4, 6, 4, 6, 10),
  ];

  it('builds weeks starting on Monday', () => {
    const weeks = resampleCalendar(daily, 'week', utc);
    expect(weeks).toHaveLength(3);
    expect(weeks[0]).toEqual({ time: t('2024-01-01T00:00:00Z'), open: 1, high: 9, low: 1, close: 3, volume: 30 });
  });

  it('builds calendar months', () => {
    const months = resampleCalendar(daily, 'month', utc);
    expect(months.map((m) => m.time)).toEqual([t('2024-01-01T00:00:00Z'), t('2024-02-01T00:00:00Z')]);
    expect(months[0].close).toBe(4);
  });

  it('puts a Sunday with the week that just ended, not the one beginning', () => {
    const bars = [bar('2024-01-05T00:00:00Z', 1, 1, 1, 1), bar('2024-01-07T00:00:00Z', 2, 2, 2, 2)]; // Fri, Sun
    expect(resampleCalendar(bars, 'week', utc)).toHaveLength(1);
  });
});

describe('resampleTo', () => {
  const minute5 = { kind: 'minutes', minutes: 5 } as const;
  const bars = [bar('2024-01-02T09:00:00Z', 1, 1, 1, 1), bar('2024-01-02T09:05:00Z', 2, 2, 2, 2)];

  it('returns the same bars when timeframes match', () => {
    expect(resampleTo(bars, minute5, minute5, utc)).toBe(bars);
  });

  it('builds a coarser intraday timeframe that is a multiple', () => {
    expect(resampleTo(bars, minute5, { kind: 'minutes', minutes: 10 }, utc)).toHaveLength(1);
  });

  it('refuses a finer timeframe or a non-multiple', () => {
    expect(resampleTo(bars, minute5, { kind: 'minutes', minutes: 1 }, utc)).toBeNull();
    expect(resampleTo(bars, minute5, { kind: 'minutes', minutes: 7 }, utc)).toBeNull();
    expect(resampleTo(bars, { kind: 'day' }, minute5, utc)).toBeNull();
    expect(resampleTo(bars, { kind: 'week' }, { kind: 'day' }, utc)).toBeNull();
  });

  it('builds calendar timeframes from finer ones', () => {
    expect(resampleTo(bars, minute5, { kind: 'day' }, utc)).toHaveLength(1);
  });
});

describe('localMidnight', () => {
  it('is midnight of that calendar date in the local timezone', () => {
    const d = new Date(localMidnight('2024-03-15'));
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2024, 2, 15, 0]);
  });
});

describe('toKitePlan', () => {
  const plan = (tf: string) => toKitePlan(parseTimeframe(tf)!);

  it('uses Kite-native intervals directly', () => {
    for (const m of ['1', '3', '5', '10', '15', '30', '60']) expect(plan(m)).toEqual({ interval: m });
    expect(plan('D')).toEqual({ interval: 'D' });
  });

  it('builds everything else from the coarsest native interval that divides it', () => {
    expect(plan('45')).toEqual({ interval: '15', groupSize: 3 });
    expect(plan('90')).toEqual({ interval: '30', groupSize: 3 });
    expect(plan('120')).toEqual({ interval: '60', groupSize: 2 });
    expect(plan('240')).toEqual({ interval: '60', groupSize: 4 });
    expect(plan('20')).toEqual({ interval: '10', groupSize: 2 });
    expect(plan('25')).toEqual({ interval: '5', groupSize: 5 });
    expect(plan('2')).toEqual({ interval: '1', groupSize: 2 });
  });

  it('builds weeks and months from daily bars', () => {
    expect(plan('W')).toEqual({ interval: 'D', resampleDaily: 'week' });
    expect(plan('M')).toEqual({ interval: 'D', resampleDaily: 'month' });
  });

  it('refuses anything longer than a trading day', () => {
    expect(plan('2880')).toBeNull();
  });
});

describe('toFyersPlan', () => {
  const plan = (tf: string) => toFyersPlan(parseTimeframe(tf)!);

  it('uses FYERS-native intervals directly, including the ones Kite lacks', () => {
    for (const m of ['1', '2', '3', '5', '10', '15', '20', '30', '60', '120', '240']) expect(plan(m)).toEqual({ interval: m });
    expect(plan('D')).toEqual({ interval: 'D' });
  });

  it('builds the rest the same way as for Kite', () => {
    expect(plan('45')).toEqual({ interval: '15', groupSize: 3 });
    expect(plan('180')).toEqual({ interval: '60', groupSize: 3 });
    expect(plan('480')).toEqual({ interval: '240', groupSize: 2 });
    expect(plan('W')).toEqual({ interval: 'D', resampleDaily: 'week' });
  });

  it('is what toBrokerPlan gives for each broker', () => {
    const tf = parseTimeframe('120')!;
    expect(toBrokerPlan('fyers', tf)).toEqual({ interval: '120' });
    expect(toBrokerPlan('zerodha', tf)).toEqual({ interval: '60', groupSize: 2 });
  });
});
