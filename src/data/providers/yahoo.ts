import type { BarRange, DataProvider, OHLCV, ProviderInfo } from '@luxalgo/vela';
import { errorMessage, fetchBars, type BarsResponse } from '../../lib/ipc';
import { parseTimeframe, timeframeMs, toYahooPlan, type Timeframe, type YahooPlan } from '../../lib/timeframes';
import { notify } from '../events';
import { coalesce } from '../inflight';
import { subscribePolled } from '../livePoll';
import { clipToRange, DAY_MS, DEFAULT_BAR_COUNT, isBackfillRequest, lookbackMs, toChartBars } from './common';

const SUPPORTED_TIMEFRAMES = ['1', '2', '5', '15', '30', '60', '90', '120', '180', '240', 'D', 'W', 'M'];

const POLL_INTERVAL_MS = { intraday: 15_000, daily: 60_000 } as const;
/** A market that's closed produces no new ticks; after this many identical
 *  polls in a row the feed backs off instead of hitting Yahoo every 15s all weekend. */
const IDLE_POLLS_BEFORE_BACKOFF = 4;
const IDLE_POLL_INTERVAL_MS = 120_000;
/** After failed polls (a rate limit, no network) the delay doubles up to this. */
const MAX_FAILURE_INTERVAL_MS = 300_000;

function resolve(timeframe: string): { tf: Timeframe; plan: YahooPlan } | null {
  const tf = parseTimeframe(timeframe);
  const plan = tf && toYahooPlan(tf);
  return tf && plan ? { tf, plan } : null;
}

/** Stocks, ETFs, indices, FX, futures and crypto from Yahoo Finance's public
 *  (unofficial, key-less) chart API, fetched through the Rust backend so it
 *  isn't subject to browser CORS and can be cached for offline use. Delayed
 *  quotes on some exchanges; live updates are simulated by polling. */
export class YahooProvider implements DataProvider {
  info(): ProviderInfo {
    return {
      name: 'yahoo',
      displayName: 'Yahoo Finance',
      supportedTimeframes: SUPPORTED_TIMEFRAMES,
      capabilities: { enumerate: false, stream: true, symbolInfo: false },
    };
  }

  private readonly loading = new Map<string, Promise<OHLCV[]>>();

  /** Every chart of a grid that boots on the same symbol asks for the same
   *  history at the same instant; identical simultaneous requests share one
   *  fetch (and one error toast). Each caller gets its own copy of the bars. */
  async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
    const key = `${ticker}|${timeframe}|${range.from ?? ''}|${range.to ?? ''}|${range.limit ?? ''}`;
    const bars = await coalesce(this.loading, key, () => this.loadBars(ticker, timeframe, range));
    return bars.map((bar) => ({ ...bar }));
  }

  private async loadBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
    const target = resolve(timeframe);
    if (!target) {
      notify('error', `Yahoo Finance can't serve the "${timeframe}" timeframe.`);
      return [];
    }
    const { tf, plan } = target;
    const limit = range.limit ?? DEFAULT_BAR_COUNT;
    const from = range.from ?? (range.to ?? Date.now()) - lookbackMs(tf, limit);
    // A daily bar is stamped at local midnight but Yahoo dates it by the
    // exchange's session open, which can fall on the other side of that
    // instant. Ask a day wider and clip to the exact range afterwards, so a
    // bar on the boundary is neither lost nor duplicated.
    const pad = tf.kind === 'minutes' ? 0 : DAY_MS;

    let res: BarsResponse;
    try {
      res = await fetchBars(ticker, plan.interval, from - pad, range.to === undefined ? undefined : range.to + pad);
    } catch (err) {
      // Older history is loaded behind a chart that already works. A failure
      // there is thrown, not reported: Vela stops that backfill and keeps
      // what it has, and the chart tries again later (see historyBackfill.ts).
      if (isBackfillRequest(range)) throw new Error(errorMessage(err));
      // Otherwise it's reported through a toast and answered with "no bars":
      // throwing would leave Vela's loading indicator spinning on a chart that
      // will never fill.
      notify('error', errorMessage(err));
      return [];
    }
    if (res.fromCache && !isBackfillRequest(range)) {
      notify('info', `Yahoo Finance is unavailable — showing cached ${ticker} data.`);
    }

    const bars = clipToRange(toChartBars(res, tf, plan), { from: range.from, to: range.to });
    return range.limit !== undefined && bars.length > range.limit ? bars.slice(-range.limit) : bars;
  }

  /** Polls the newest bars rather than streaming: Yahoo has no public socket.
   *  Charts showing the same symbol and timeframe share one poller. */
  subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): () => void {
    const target = resolve(timeframe);
    if (!target) return () => {};
    const { tf, plan } = target;
    const base = tf.kind === 'minutes' ? POLL_INTERVAL_MS.intraday : POLL_INTERVAL_MS.daily;
    // Enough history that the newest (possibly grouped) bar is complete, and
    // that a weekend or holiday gap still leaves something to show.
    const span = tf.kind === 'minutes' ? 4 * DAY_MS : timeframeMs(tf) * 4;

    const load = async () => {
      const res = await fetchBars(ticker, plan.interval, Date.now() - span);
      // Cached bars mean the request failed; treating that as "nothing new"
      // would keep polling at full speed into whatever is refusing us.
      if (res.fromCache) throw new Error('Yahoo Finance is unavailable');
      // The last two bars: a fresh bar may have opened since the previous
      // poll, and the one before it needs its final values.
      return toChartBars(res, tf, plan).slice(-2);
    };
    return subscribePolled(
      `yahoo|${ticker}|${timeframe}`,
      {
        baseMs: base,
        idleMs: IDLE_POLL_INTERVAL_MS,
        idlePollsBeforeBackoff: IDLE_POLLS_BEFORE_BACKOFF,
        maxFailureMs: MAX_FAILURE_INTERVAL_MS,
      },
      load,
      (bars) => bars.forEach(onBar),
    );
  }
}
