import { describe, expect, it } from 'vitest';
import type { OHLCV } from '@luxalgo/vela';
import type { BarsResponse } from '../../lib/ipc';
import { localMidnight, parseTimeframe, toYahooPlan } from '../../lib/timeframes';
import { clipToRange, toChartBars } from './common';

const raw = (iso: string, close: number, volume: number | null = 100) => ({
  time: Date.parse(iso),
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume,
});

const response = (bars: BarsResponse['bars'], gmtOffset: number): BarsResponse => ({
  bars,
  gmtOffset,
  timezone: null,
  fromCache: false,
});

const planFor = (tf: string) => {
  const parsed = parseTimeframe(tf)!;
  return { tf: parsed, plan: toYahooPlan(parsed)! };
};

describe('toChartBars', () => {
  it('stamps daily bars at local midnight of the exchange calendar date', () => {
    // 09:15 IST on 2 Jan is 03:45 UTC the same day; Sydney's 10:00 open on 2 Jan is
    // 23:00 UTC on 1 Jan — both must land on their own exchange date.
    const { tf, plan } = planFor('D');
    const india = toChartBars(response([raw('2024-01-02T03:45:00Z', 10)], 19800), tf, plan);
    const sydney = toChartBars(response([raw('2024-01-01T23:00:00Z', 20)], 39600), tf, plan);
    expect(india[0].time).toBe(localMidnight('2024-01-02'));
    expect(sydney[0].time).toBe(localMidnight('2024-01-02'));
  });

  it('keeps intraday bars at their real instant and maps missing volume to undefined', () => {
    const { tf, plan } = planFor('15');
    const bars = toChartBars(response([raw('2024-01-02T14:30:00Z', 10, null)], -18000), tf, plan);
    expect(bars[0].time).toBe(Date.parse('2024-01-02T14:30:00Z'));
    expect(bars[0].volume).toBeUndefined();
  });

  it('builds non-native intraday timeframes within each exchange day', () => {
    // Four 60m bars per session (US, UTC-5): 4h groups them into one candle per day.
    const { tf, plan } = planFor('240');
    const day = (d: string) => ['14:30', '15:30', '16:30', '17:30'].map((t, i) => raw(`${d}T${t}:00Z`, 10 + i));
    const bars = toChartBars(response([...day('2024-01-02'), ...day('2024-01-03')], -18000), tf, plan);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ open: 10, close: 13, volume: 400 });
  });
});

describe('clipToRange', () => {
  const bars: OHLCV[] = [10, 20, 30, 40].map((time) => ({ time, open: 1, high: 1, low: 1, close: 1 }));

  it('keeps bars inside the range, inclusive at both ends', () => {
    expect(clipToRange(bars, { from: 20, to: 30 }).map((b) => b.time)).toEqual([20, 30]);
  });

  it('treats a missing end as unbounded', () => {
    expect(clipToRange(bars, { from: 30 }).map((b) => b.time)).toEqual([30, 40]);
    expect(clipToRange(bars, { to: 20 }).map((b) => b.time)).toEqual([10, 20]);
    expect(clipToRange(bars, {})).toBe(bars);
  });
});
