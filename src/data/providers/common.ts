import type { BarRange, OHLCV } from '@luxalgo/vela';
import type { BarsResponse } from '../../lib/ipc';
import {
  exchangeDayKey,
  localDayKey,
  localMidnight,
  resampleCalendar,
  resampleIntraday,
  timeframeMs,
  type Timeframe,
} from '../../lib/timeframes';

/** Helpers shared by the providers that fetch bars through the Rust backend
 *  (Dhan, Zerodha): sizing a request, converting the response into what Vela
 *  draws, and clipping to the range Vela asked for. */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Bars requested when the chart doesn't say how many it wants. */
export const DEFAULT_BAR_COUNT = 1500;

/** How far back to ask for `limit` bars when the caller gives no start time.
 *  Intraday bars only exist during market hours (~6.5h of 24, 5 days of 7), so
 *  the calendar span has to be several times larger than bars × bar-length;
 *  the result is trimmed to `limit` afterwards. */
export function lookbackMs(tf: Timeframe, limit: number): number {
  const factor = tf.kind === 'minutes' ? (tf.minutes >= 24 * 60 ? 1 : 6) : tf.kind === 'day' ? 1.6 : 1;
  // Never less than the longest stretch a market can plausibly stay closed. A
  // backward history load ends at the oldest bar already on the chart, which
  // may sit right after a weekend or a holiday run; a shorter window would
  // come back empty, and the chart reads an empty answer as "no older history".
  const intraday = tf.kind === 'minutes' && tf.minutes < 24 * 60;
  const closure = intraday ? 7 * DAY_MS : tf.kind === 'day' ? 10 * DAY_MS : 0;
  return Math.max(limit * timeframeMs(tf) * factor, closure);
}

/** Whether Vela is asking for older history: "the `limit` bars ending at `to`",
 *  with no start time. Every provider sees these while the user scrolls back. */
export function isBackfillRequest(range: Pick<BarRange, 'from' | 'to'>): boolean {
  return range.to !== undefined && range.from === undefined;
}

/** How a provider's native bars become the requested timeframe. */
export interface ChartPlan {
  /** Build intraday bars by grouping this many native bars within a trading day. */
  groupSize?: number;
  /** Build weekly/monthly bars from daily ones (the source has no such interval). */
  resampleDaily?: 'week' | 'month';
}

/** Turns a provider's raw bars into what Vela draws: daily-and-up bars stamped at
 *  local midnight of the exchange's calendar date (so date labels never slip a
 *  day across timezones), and non-native timeframes built by resampling. */
export function toChartBars(res: BarsResponse, tf: Timeframe, plan: ChartPlan): OHLCV[] {
  const dayKey = exchangeDayKey(res.gmtOffset);
  const bars: OHLCV[] = res.bars.map((b) => ({
    time: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume ?? undefined,
  }));
  if (tf.kind === 'minutes') return plan.groupSize ? resampleIntraday(bars, plan.groupSize, dayKey) : bars;

  const stamped = bars.map((b) => ({ ...b, time: localMidnight(dayKey(b.time)) }));
  // The stamped times are local midnights, so grouping uses the local calendar.
  return plan.resampleDaily ? resampleCalendar(stamped, plan.resampleDaily, localDayKey) : stamped;
}

/** Bars whose stamped time falls inside `range` (both ends inclusive). */
export function clipToRange(bars: OHLCV[], range: Pick<BarRange, 'from' | 'to'>): OHLCV[] {
  const { from, to } = range;
  if (from === undefined && to === undefined) return bars;
  return bars.filter((b) => (from === undefined || b.time >= from) && (to === undefined || b.time <= to));
}
