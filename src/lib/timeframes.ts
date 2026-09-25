import type { OHLCV } from '@luxalgo/vela';

/** Vela timeframes are canonical strings: minutes as bare digits (`"5"`,
 *  `"60"`), and `D` / `W` / `M` for day / week / month. `"1D"`-style spellings
 *  (a count in front of the unit) are accepted too. */
export type Timeframe =
  | { kind: 'minutes'; minutes: number }
  | { kind: 'day' }
  | { kind: 'week' }
  | { kind: 'month' };

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export function parseTimeframe(tf: string): Timeframe | null {
  const t = tf.trim();
  if (/^\d+$/.test(t)) {
    const minutes = Number(t);
    return minutes > 0 ? { kind: 'minutes', minutes } : null;
  }
  const hours = /^(\d+)H$/i.exec(t);
  if (hours) return { kind: 'minutes', minutes: Number(hours[1]) * 60 };

  // Only a count of 1 is meaningful for calendar units ("2W" isn't offered).
  const unit = /^(\d*)([DWM])$/i.exec(t);
  if (unit && (unit[1] === '' || unit[1] === '1')) {
    return { kind: ({ D: 'day', W: 'week', M: 'month' } as const)[unit[2].toUpperCase() as 'D' | 'W' | 'M'] };
  }
  return null;
}

/** Canonical Vela spelling of a parsed timeframe. */
export function timeframeToString(tf: Timeframe): string {
  switch (tf.kind) {
    case 'minutes':
      return String(tf.minutes);
    case 'day':
      return 'D';
    case 'week':
      return 'W';
    case 'month':
      return 'M';
  }
}

/** Nominal bar length in ms — only for sizing how far back to ask for data. */
export function timeframeMs(tf: Timeframe): number {
  switch (tf.kind) {
    case 'minutes':
      return tf.minutes * MINUTE_MS;
    case 'day':
      return DAY_MS;
    case 'week':
      return 7 * DAY_MS;
    case 'month':
      return 30 * DAY_MS;
  }
}

// ---- Resampling ------------------------------------------------------------

export type DayKeyFn = (timeMs: number) => string;

/** `YYYY-MM-DD` of an instant in the machine's local timezone. */
export const localDayKey: DayKeyFn = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** `YYYY-MM-DD` of an instant in an exchange's timezone, given its UTC offset. */
export function exchangeDayKey(gmtOffsetSec: number): DayKeyFn {
  return (ms) => new Date(ms + gmtOffsetSec * 1000).toISOString().slice(0, 10);
}

function merge(group: OHLCV[]): OHLCV {
  const first = group[0];
  const last = group[group.length - 1];
  let high = -Infinity;
  let low = Infinity;
  let volume: number | undefined;
  for (const b of group) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    if (b.volume !== undefined) volume = (volume ?? 0) + b.volume;
  }
  return { time: first.time, open: first.open, high, low, close: last.close, volume };
}

function groupBy(bars: OHLCV[], keyOf: (bar: OHLCV, index: number) => string): OHLCV[] {
  const out: OHLCV[] = [];
  let group: OHLCV[] = [];
  let key = '';
  bars.forEach((bar, i) => {
    const k = keyOf(bar, i);
    if (group.length > 0 && k !== key) {
      out.push(merge(group));
      group = [];
    }
    key = k;
    group.push(bar);
  });
  if (group.length > 0) out.push(merge(group));
  return out;
}

/** Builds coarser intraday bars by grouping `groupSize` consecutive bars
 *  WITHIN each trading day, restarting at every session open — the way a
 *  charting platform builds 4h candles (09:30–13:30, 13:30–close), rather than
 *  slicing on fixed clock boundaries that split a session arbitrarily. */
export function resampleIntraday(bars: OHLCV[], groupSize: number, dayKey: DayKeyFn): OHLCV[] {
  if (groupSize <= 1) return bars;
  let day = '';
  let indexInDay = 0;
  return groupBy(bars, (bar) => {
    const d = dayKey(bar.time);
    indexInDay = d === day ? indexInDay + 1 : 0;
    day = d;
    return `${d}#${Math.floor(indexInDay / groupSize)}`;
  });
}

/** `YYYY-MM-DD` of the Monday starting the week containing that date. */
function weekStart(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - sinceMonday);
  return date.toISOString().slice(0, 10);
}

/** Groups bars into calendar days / weeks / months. */
export function resampleCalendar(bars: OHLCV[], unit: 'day' | 'week' | 'month', dayKey: DayKeyFn): OHLCV[] {
  return groupBy(bars, (bar) => {
    const d = dayKey(bar.time);
    return unit === 'day' ? d : unit === 'week' ? weekStart(d) : d.slice(0, 7);
  });
}

/** Resamples bars of a finer timeframe up to `target`. Returns `null` when the
 *  target is finer than (or not built from) the source. */
export function resampleTo(bars: OHLCV[], source: Timeframe, target: Timeframe, dayKey: DayKeyFn): OHLCV[] | null {
  if (timeframeToString(source) === timeframeToString(target)) return bars;

  if (target.kind === 'minutes') {
    if (source.kind !== 'minutes' || target.minutes % source.minutes !== 0 || target.minutes < source.minutes) return null;
    return resampleIntraday(bars, target.minutes / source.minutes, dayKey);
  }
  // Calendar targets: the source must be strictly finer.
  const rank = { minutes: 0, day: 1, week: 2, month: 3 } as const;
  if (rank[source.kind] >= rank[target.kind]) return null;
  return resampleCalendar(bars, target.kind, dayKey);
}

/** Local midnight of a `YYYY-MM-DD` date — how daily-and-up bars are stamped so
 *  the chart's date labels match the exchange's calendar day. */
export function localMidnight(dayKey: string): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

// ---- Dhan ------------------------------------------------------------------

/** How Dhan should be asked for a timeframe. Dhan serves 1, 5, 15, 25 and 60
 *  minute bars and daily bars; everything else is built from those — grouped
 *  within the trading day (`groupSize`), or, for weeks and months, from daily
 *  bars (`resampleDaily`). */
export interface DhanPlan {
  /** `"D"` or a native minute count as a string. */
  interval: string;
  groupSize?: number;
  resampleDaily?: 'week' | 'month';
}

/** Largest first, so the coarsest divisor wins (4h = 4 × 60m, not 240 × 1m). */
const DHAN_MINUTES = [60, 25, 15, 5, 1];

export function toDhanPlan(tf: Timeframe): DhanPlan | null {
  switch (tf.kind) {
    case 'day':
      return { interval: 'D' };
    case 'week':
      return { interval: 'D', resampleDaily: 'week' };
    case 'month':
      return { interval: 'D', resampleDaily: 'month' };
    case 'minutes': {
      if (tf.minutes > 24 * 60) return null;
      const base = DHAN_MINUTES.find((m) => tf.minutes % m === 0);
      if (base === undefined) return null;
      return base === tf.minutes ? { interval: String(base) } : { interval: String(base), groupSize: tf.minutes / base };
    }
  }
}

// ---- Zerodha ---------------------------------------------------------------

/** How Zerodha (Kite Connect) should be asked for a timeframe. Kite serves 1, 3,
 *  5, 10, 15, 30 and 60 minute bars and daily bars; everything else is built
 *  from those, the same way as for Dhan. */
export interface KitePlan {
  /** `"D"` or a native minute count as a string. */
  interval: string;
  groupSize?: number;
  resampleDaily?: 'week' | 'month';
}

/** Largest first, so the coarsest divisor wins (4h = 4 × 60m, not 240 × 1m). */
const KITE_MINUTES = [60, 30, 15, 10, 5, 3, 1];

export function toKitePlan(tf: Timeframe): KitePlan | null {
  switch (tf.kind) {
    case 'day':
      return { interval: 'D' };
    case 'week':
      return { interval: 'D', resampleDaily: 'week' };
    case 'month':
      return { interval: 'D', resampleDaily: 'month' };
    case 'minutes': {
      if (tf.minutes > 24 * 60) return null;
      const base = KITE_MINUTES.find((m) => tf.minutes % m === 0);
      if (base === undefined) return null;
      return base === tf.minutes ? { interval: String(base) } : { interval: String(base), groupSize: tf.minutes / base };
    }
  }
}
