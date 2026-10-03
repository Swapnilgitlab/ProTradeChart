import type { BarRange, DataProvider, OHLCV, ProviderInfo as VelaProviderInfo, SymbolDescriptor } from '@luxalgo/vela';
import {
  errorMessage,
  listNseEquities,
  zerodhaFetchBars,
  zerodhaSubscribe,
  zerodhaUnsubscribe,
  type BarsResponse,
} from '../../lib/ipc';
import { LiveBarBuilder, sessionOpenForExchange, type Tick } from '../../lib/liveBar';
import { parseTimeframe, timeframeToString, toKitePlan, type KitePlan, type Timeframe } from '../../lib/timeframes';
import { notify } from '../events';
import { ensureProvidersLoaded, isProviderUsable } from '../providerStatus';
import { onZerodhaTick } from '../zerodhaLive';
import { clipToRange, DAY_MS, DEFAULT_BAR_COUNT, isBackfillRequest, lookbackMs, toChartBars } from './common';

const SUPPORTED_TIMEFRAMES = ['1', '3', '5', '10', '15', '30', '45', '60', '120', '180', '240', 'D', 'W', 'M'];

const NOT_SET_UP =
  "Zerodha isn't set up. Open Data providers, enter your API key and secret, log in, and turn Zerodha on.";

function resolve(timeframe: string): { tf: Timeframe; plan: KitePlan } | null {
  const tf = parseTimeframe(timeframe);
  const plan = tf && toKitePlan(tf);
  return tf && plan ? { tf, plan } : null;
}

/** Indian equities, indices, futures and commodities from the user's own
 *  Zerodha (Kite Connect) app. Symbols are `zerodha:EXCHANGE:SYMBOL`
 *  (`zerodha:NSE:RELIANCE`, `zerodha:NSE:NIFTY_50`); the backend maps them to
 *  Kite's instrument tokens using the downloaded instrument list, and keeps the
 *  access token out of the webview.
 *
 *  History comes from Kite's historical-data API. Live candles are built from
 *  the tick feed, which the backend shares across every chart and window. */
export class ZerodhaProvider implements DataProvider {
  /** The newest bar returned for each ticker/timeframe, so live ticks continue
   *  it instead of starting a duplicate. */
  private readonly newestBar = new Map<string, OHLCV>();

  info(): VelaProviderInfo {
    return {
      name: 'zerodha',
      displayName: 'Zerodha',
      requiresApiKey: true,
      supportedTimeframes: SUPPORTED_TIMEFRAMES,
      capabilities: { enumerate: true, stream: true, symbolInfo: false },
    };
  }

  /** NSE equities only (~2,000 symbols) — this is what lets Vela's OWN symbol search (bare-typing,
   *  or clicking a chart's symbol name) find an NSE stock at all; without it that search has
   *  nothing indexed for this provider and comes back empty. The app's own search box doesn't use
   *  this — it searches everything live, including BSE, F&O and indices. Read once, when Vela
   *  registers this provider; a broker connected mid-session needs a restart to be indexed. */
  async listSymbols(): Promise<SymbolDescriptor[]> {
    await ensureProvidersLoaded();
    if (!isProviderUsable('zerodha')) return [];
    try {
      const rows = await listNseEquities('zerodha');
      return rows.map((r) => ({ ticker: r.symbol, description: r.name ?? undefined, type: 'stock' }));
    } catch {
      return [];
    }
  }

  async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
    await ensureProvidersLoaded();
    if (!isProviderUsable('zerodha')) {
      notify('error', NOT_SET_UP);
      return [];
    }
    const target = resolve(timeframe);
    if (!target) {
      notify('error', `Zerodha can't serve the "${timeframe}" timeframe.`);
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
      res = await zerodhaFetchBars(ticker, plan.interval, from - pad, range.to === undefined ? undefined : range.to + pad);
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
      .then(() => (isProviderUsable('zerodha') ? zerodhaSubscribe(ticker) : null))
      .then((sub) => {
        if (!sub) return;
        if (cancelled) {
          // Unsubscribed before the backend answered: hand the subscription straight back.
          void zerodhaUnsubscribe(ticker).catch(() => {});
          return;
        }
        subscribed = true;
        const builder = new LiveBarBuilder({
          tf,
          sessionOpenMin: sessionOpenForExchange(sub.exchange),
          seed: this.newestBar.get(`${ticker}|${timeframeToString(tf)}`) ?? null,
        });
        stopTicks = onZerodhaTick(sub.token, (t) => {
          const tick: Tick = { ltp: t.ltp, ltt: t.ltt, volume: t.volume };
          const bar = builder.onTick(tick, Date.now());
          if (bar) onBar(bar);
        });
      })
      .catch((err) => notify('error', errorMessage(err)));

    return () => {
      cancelled = true;
      stopTicks?.();
      if (subscribed) void zerodhaUnsubscribe(ticker).catch(() => {});
    };
  }
}
