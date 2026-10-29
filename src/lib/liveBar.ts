import type { OHLCV } from '@luxalgo/vela';
import { localMidnight, type Timeframe } from './timeframes';

/** Turns a stream of trade ticks into the forming candle Vela draws, for
 *  a broker that streams ticks rather than candles (Zerodha), or whose quotes
 *  are polled (FYERS).
 *
 *  Indian markets: bars are anchored to the session open (09:15 IST for equities
 *  and derivatives, 09:00 for currency and commodities), so a 5-minute chart has
 *  bars at 09:15, 09:20, … — not on the clock's round numbers. */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 19_800_000;
/** Seconds between the Unix epoch and 1 Jan 1980, an epoch some Indian broker feeds have used. */
const EPOCH_1980_OFFSET_S = 315_532_800;
const IST_OFFSET_S = 19_800;
/** A tick's own timestamp is trusted only if it lands this close to the local clock. */
const CLOCK_TOLERANCE_MS = 10 * MINUTE_MS;

/** Minutes after midnight IST at which an exchange opens: currency (CDS,
 *  BCD) and commodity (MCX) sessions start at 09:00, everything else at 09:15. */
export function sessionOpenForExchange(exchange: string): number {
  return exchange === 'CDS' || exchange === 'BCD' || exchange === 'MCX' ? 9 * 60 : 9 * 60 + 15;
}

/** Works out a tick's real time. A feed's docs may say only "epoch", and the base
 *  has been seen to vary, so the tick's timestamp is tried under each plausible reading and
 *  the one that lands within minutes of the local clock wins. If none does (or
 *  there is no timestamp), the arrival time is used. */
export function resolveTickTime(ltt: number | null, receivedAtMs: number): number {
  if (ltt === null || !Number.isFinite(ltt)) return receivedAtMs;
  const candidates = [0, EPOCH_1980_OFFSET_S, -IST_OFFSET_S, EPOCH_1980_OFFSET_S - IST_OFFSET_S, IST_OFFSET_S].map(
    (shift) => (ltt + shift) * 1000,
  );
  const best = candidates.reduce((a, b) => (Math.abs(b - receivedAtMs) < Math.abs(a - receivedAtMs) ? b : a));
  return Math.abs(best - receivedAtMs) <= CLOCK_TOLERANCE_MS ? best : receivedAtMs;
}

export interface Tick {
  ltp: number;
  /** The broker's last-trade time, raw. */
  ltt: number | null;
  /** Total volume traded so far today, when the feed sends it. */
  volume: number | null;
  /** The day's own open, high and low, when the tick is a polled quote that carries them. A daily
   *  (or weekly, monthly) bar takes them, because polling misses the trades between samples. */
  dayOpen?: number | null;
  dayHigh?: number | null;
  dayLow?: number | null;
}

const positive = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** `YYYY-MM-DD` of an instant in IST. */
function istDate(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function weekStart(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

interface Bucket {
  /** Identity of the bucket: two ticks with the same key belong to one bar. */
  key: string;
  /** The bar's stamped time, when this tick is the first in its bucket. */
  time: number;
}

/** Which bar a tick belongs to, or `null` for a tick that shouldn't draw
 *  (before the session opens, e.g. the pre-open auction). */
export function bucketFor(tf: Timeframe, timeMs: number, sessionOpenMin: number): Bucket | null {
  const ist = timeMs + IST_OFFSET_MS;
  switch (tf.kind) {
    case 'minutes': {
      const dayStart = Math.floor(ist / DAY_MS) * DAY_MS;
      const minutesIntoDay = (ist - dayStart) / MINUTE_MS;
      if (minutesIntoDay < sessionOpenMin) return null;
      const slot = Math.floor((minutesIntoDay - sessionOpenMin) / tf.minutes);
      const startMinutes = sessionOpenMin + slot * tf.minutes;
      const time = dayStart - IST_OFFSET_MS + startMinutes * MINUTE_MS;
      return { key: String(time), time };
    }
    case 'day': {
      const date = istDate(timeMs);
      return { key: date, time: localMidnight(date) };
    }
    case 'week': {
      const date = istDate(timeMs);
      return { key: weekStart(date), time: localMidnight(date) };
    }
    case 'month': {
      const date = istDate(timeMs);
      return { key: date.slice(0, 7), time: localMidnight(date) };
    }
  }
}

export interface LiveBarOptions {
  tf: Timeframe;
  sessionOpenMin: number;
  /** The newest bar already on the chart, so live updates continue it rather
   *  than starting a duplicate. */
  seed?: OHLCV | null;
}

export class LiveBarBuilder {
  private bar: OHLCV | null;
  private barKey: string | null;
  /** The bar's volume before live ticks were added to it. */
  private baseVolume: number;
  /** The day's cumulative volume when the current bar started (or first seen). */
  private cumulativeAtBase: number | null = null;

  constructor(private readonly opts: LiveBarOptions) {
    const seed = opts.seed ?? null;
    this.bar = seed ? { ...seed } : null;
    this.baseVolume = seed?.volume ?? 0;
    // A seed's bucket key comes from its own stamped time.
    this.barKey = seed ? (bucketFor(opts.tf, this.timeForSeed(seed), opts.sessionOpenMin)?.key ?? null) : null;
  }

  /** A seed bar's stamped time is either an exact instant (intraday) or a local
   *  midnight of an exchange date (daily and up) — either way it lies within its
   *  own bucket, which is all `bucketFor` needs. */
  private timeForSeed(seed: OHLCV): number {
    // Local midnight can fall on the previous IST date in some timezones; noon
    // of that local day is safely inside the right IST date.
    return this.opts.tf.kind === 'minutes' ? seed.time : seed.time + 12 * 60 * MINUTE_MS;
  }

  /** Folds a tick in and returns the bar as it now stands, or `null` if the
   *  tick doesn't belong on the chart. */
  onTick(tick: Tick, receivedAtMs: number): OHLCV | null {
    if (!Number.isFinite(tick.ltp) || tick.ltp <= 0) return null;
    const timeMs = resolveTickTime(tick.ltt, receivedAtMs);
    const bucket = bucketFor(this.opts.tf, timeMs, this.opts.sessionOpenMin);
    if (!bucket) return null;

    const daily = this.opts.tf.kind !== 'minutes';
    if (!this.bar || this.barKey !== bucket.key) {
      // A new bucket. (A seed that lies in it keeps its own time and prices.)
      const open = daily && positive(tick.dayOpen) ? tick.dayOpen : tick.ltp;
      this.bar = { time: bucket.time, open, high: Math.max(open, tick.ltp), low: Math.min(open, tick.ltp), close: tick.ltp, volume: undefined };
      this.barKey = bucket.key;
      this.baseVolume = 0;
      this.cumulativeAtBase = tick.volume;
    } else {
      this.bar.high = Math.max(this.bar.high, tick.ltp);
      this.bar.low = Math.min(this.bar.low, tick.ltp);
      this.bar.close = tick.ltp;
    }
    if (daily) {
      if (positive(tick.dayHigh)) this.bar.high = Math.max(this.bar.high, tick.dayHigh);
      if (positive(tick.dayLow)) this.bar.low = Math.min(this.bar.low, tick.dayLow);
    }

    if (tick.volume !== null) {
      if (this.opts.tf.kind === 'day') {
        // The feed's figure IS the day's volume.
        this.bar.volume = tick.volume;
      } else {
        this.cumulativeAtBase ??= tick.volume;
        this.bar.volume = this.baseVolume + Math.max(0, tick.volume - this.cumulativeAtBase);
      }
    }
    return { ...this.bar };
  }
}
