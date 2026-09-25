import type { BarRange, DataProvider, OHLCV, ProviderInfo as VelaProviderInfo } from '@luxalgo/vela';
import { dhanFetchBars, dhanSubscribe, dhanUnsubscribe, errorMessage, type BarsResponse } from '../../lib/ipc';
import { LiveBarBuilder, sessionOpenMinutes, type Tick } from '../../lib/liveBar';
import { parseTimeframe, timeframeToString, toDhanPlan, type DhanPlan, type Timeframe } from '../../lib/timeframes';
import { onDhanTick } from '../dhanLive';
import { notify } from '../events';
import { ensureProvidersLoaded, isProviderUsable } from '../providerStatus';
import { clipToRange, DAY_MS, DEFAULT_BAR_COUNT, isBackfillRequest, lookbackMs, toChartBars } from './common';

const SUPPORTED_TIMEFRAMES = ['1', '3', '5', '10', '15', '25', '30', '45', '60', '120', '180', '240', 'D', 'W', 'M'];

const NOT_SET_UP =
  "Dhan isn't set up. Open Data providers, enter your client ID and access token, and turn Dhan on.";

function resolve(timeframe: string): { tf: Timeframe; plan: DhanPlan } | null {
  const tf = parseTimeframe(timeframe);
  const plan = tf && toDhanPlan(tf);
  return tf && plan ? { tf, plan } : null;
}

/** Indian equities, indices, futures and commodities from the user's own Dhan
 *  account. Symbols are `dhan:EXCHANGE:SYMBOL` (`dhan:NSE:RELIANCE`,
 *  `dhan:IDX:NIFTY`); the backend maps them to Dhan's security ids using the
 *  downloaded instrument list, and keeps the access token out of the webview.
 *
 *  History comes from Dhan's historical-data API. Live candles are built from
 *  the tick feed, which the backend shares across every chart and window. */
export class DhanProvider implements DataProvider {
  /** The newest bar returned for each ticker/timeframe, so live ticks continue
   *  it instead of starting a duplicate. */
  private readonly newestBar = new Map<string, OHLCV>();

  info(): VelaProviderInfo {
    return {
      name: 'dhan',
      displayName: 'Dhan',
      requiresApiKey: true,
      supportedTimeframes: SUPPORTED_TIMEFRAMES,
      capabilities: { enumerate: false, stream: true, symbolInfo: false },
    };
  }

  async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
    await ensureProvidersLoaded();
    if (!isProviderUsable('dhan')) {
      notify('error', NOT_SET_UP);
      return [];
    }
    const target = resolve(timeframe);
    if (!target) {
      notify('error', `Dhan can't serve the "${timeframe}" timeframe.`);
      return [];
    }
    const { tf, plan } = target;
    const limit = range.limit ?? DEFAULT_BAR_COUNT;
    const from = range.from ?? (range.to ?? Date.now()) - lookbackMs(tf, limit);
    // A daily bar is stamped at local midnight but the exchange dates it by its
    // session open, which can fall on the other side of that instant. Ask a day
    // wider and clip to the exact range afterwards, so a bar on the boundary is
    // neither lost nor duplicated.
    const pad = tf.kind === 'minutes' ? 0 : DAY_MS;

    let res: BarsResponse;
    try {
      res = await dhanFetchBars(ticker, plan.interval, from - pad, range.to === undefined ? undefined : range.to + pad);
    } catch (err) {
      // Older history is loaded behind a chart that already works. A failure there
      // is thrown, not reported: Vela stops that backfill and keeps what it has, and
      // the chart tries again later (see historyBackfill.ts), instead of a toast on a
      // working chart.
      if (isBackfillRequest(range)) throw new Error(errorMessage(err));
      notify('error', errorMessage(err));
      return [];
    }
    if (res.fromCache && !isBackfillRequest(range)) notify('info', `Offline — showing cached ${ticker} data.`);

    let bars = clipToRange(toChartBars(res, tf, plan), { from: range.from, to: range.to });
    if (range.limit !== undefined && bars.length > range.limit) bars = bars.slice(-range.limit);

    // Only a request for the newest data says what the forming bar looks like.
    if (range.to === undefined && bars.length > 0) {
      this.newestBar.set(`${ticker}|${timeframeToString(tf)}`, bars[bars.length - 1]);
    }
    return bars;
  }

  subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): () => void {
    const target = resolve(timeframe);
    if (!target) return () => {};
    const { tf } = target;

    let cancelled = false;
    let subscribed = false;
    let stopTicks: (() => void) | undefined;

    ensureProvidersLoaded()
      // Not set up: getBars has already said so, so stay quiet here.
      .then(() => (isProviderUsable('dhan') ? dhanSubscribe(ticker) : null))
      .then((sub) => {
        if (!sub) return;
        if (cancelled) {
          // Unsubscribed before the backend answered: hand the subscription straight back.
          void dhanUnsubscribe(ticker).catch(() => {});
          return;
        }
        subscribed = true;
        const builder = new LiveBarBuilder({
          tf,
          sessionOpenMin: sessionOpenMinutes(sub.segment),
          seed: this.newestBar.get(`${ticker}|${timeframeToString(tf)}`) ?? null,
        });
        stopTicks = onDhanTick(sub.segment, sub.securityId, (t) => {
          const tick: Tick = { ltp: t.ltp, ltt: t.ltt, volume: t.volume };
          const bar = builder.onTick(tick, Date.now());
          if (bar) onBar(bar);
        });
      })
      .catch((err) => notify('error', errorMessage(err)));

    return () => {
      cancelled = true;
      stopTicks?.();
      if (subscribed) void dhanUnsubscribe(ticker).catch(() => {});
    };
  }
}
