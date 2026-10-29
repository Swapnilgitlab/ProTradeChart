import type { BarRange, DataProvider, OHLCV, ProviderInfo as VelaProviderInfo, SymbolDescriptor } from '@luxalgo/vela';
import {
  errorMessage,
  fyersSubscribe,
  fyersUnsubscribe,
  listNseEquities,
  marketFetchBars,
  zerodhaSubscribe,
  zerodhaUnsubscribe,
  type BarsResponse,
} from '../../lib/ipc';
import { LiveBarBuilder, sessionOpenForExchange, type Tick } from '../../lib/liveBar';
import { INDIA, type BrokerId } from '../../lib/symbols';
import { parseTimeframe, timeframeToString, toBrokerPlan, type BrokerPlan, type Timeframe } from '../../lib/timeframes';
import { notify } from '../events';
import { activeBroker, brokerLabel, ensureProvidersLoaded, isProviderUsable } from '../providerStatus';
import { onFyersTick } from '../fyersLive';
import { onZerodhaTick } from '../zerodhaLive';
import { clipToRange, DAY_MS, DEFAULT_BAR_COUNT, isBackfillRequest, lookbackMs, toChartBars } from './common';

const SUPPORTED_TIMEFRAMES = ['1', '2', '3', '5', '10', '15', '20', '30', '45', '60', '120', '180', '240', 'D', 'W', 'M'];

const notSetUp = (broker: BrokerId) =>
  `${brokerLabel(broker)} isn't set up. Open Data providers, enter your app's keys, log in, and turn ${brokerLabel(broker)} on.`;

function resolve(broker: BrokerId, timeframe: string): { tf: Timeframe; plan: BrokerPlan } | null {
  const tf = parseTimeframe(timeframe);
  const plan = tf && toBrokerPlan(broker, tf);
  return tf && plan ? { tf, plan } : null;
}

/** A live feed's subscription to one ticker: ticks go to `onTick` until the returned function is called. */
type LiveStart = (ticker: string, onTick: (tick: Tick) => void) => Promise<{ exchange: string; stop: () => void } | null>;

/** Zerodha streams real trades through the one Kite socket Rust owns. */
const zerodhaLive: LiveStart = async (ticker, onTick) => {
  const sub = await zerodhaSubscribe(ticker);
  const stopTicks = onZerodhaTick(sub.token, (t) => onTick({ ltp: t.ltp, ltt: t.ltt, volume: t.volume }));
  return {
    exchange: sub.exchange,
    stop: () => {
      stopTicks();
      void zerodhaUnsubscribe(ticker).catch(() => {});
    },
  };
};

/** FYERS's quotes, polled in Rust (FYERS's own socket isn't documented), carry the day's range too. */
const fyersLive: LiveStart = async (ticker, onTick) => {
  const sub = await fyersSubscribe(ticker);
  const stopTicks = onFyersTick(sub.ticker, (t) =>
    onTick({ ltp: t.ltp, ltt: t.ltt, volume: t.volume, dayOpen: t.open, dayHigh: t.high, dayLow: t.low }),
  );
  return {
    exchange: sub.exchange,
    stop: () => {
      stopTicks();
      void fyersUnsubscribe(ticker).catch(() => {});
    },
  };
};

const LIVE: Record<BrokerId, LiveStart> = { zerodha: zerodhaLive, fyers: fyersLive };

/** Indian equities, indices, futures and commodities, from whichever of the user's own broker accounts serves them
 *  (`activeBroker`). Symbols are `india:EXCHANGE:SYMBOL` (`india:NSE:RELIANCE`, `india:NSE:NIFTY_50`) and never name
 *  the broker; the backend maps them to the broker's own instruments and keeps every credential out of the webview.
 *
 *  History comes from the broker's historical-data API, routed in Rust (`market_fetch_bars`). Live candles are built
 *  from the broker's ticks, which the backend shares across every chart and window. */
export class IndiaProvider implements DataProvider {
  /** The newest bar returned for each ticker/timeframe, so live ticks continue
   *  it instead of starting a duplicate. */
  private readonly newestBar = new Map<string, OHLCV>();

  info(): VelaProviderInfo {
    return {
      name: INDIA,
      displayName: 'Indian markets',
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
    if (!isProviderUsable(INDIA)) return [];
    try {
      const rows = await listNseEquities(INDIA);
      return rows.map((r) => ({ ticker: r.symbol, description: r.name ?? undefined, type: 'stock' }));
    } catch {
      return [];
    }
  }

  async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
    await ensureProvidersLoaded();
    const broker = activeBroker();
    if (!isProviderUsable(INDIA)) {
      notify('error', notSetUp(broker));
      return [];
    }
    const target = resolve(broker, timeframe);
    if (!target) {
      notify('error', `${brokerLabel(broker)} can't serve the "${timeframe}" timeframe.`);
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
      res = await marketFetchBars(ticker, plan.interval, from - pad, range.to === undefined ? undefined : range.to + pad);
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
    const broker = activeBroker();
    const live = LIVE[broker];
    const target = resolve(broker, timeframe);
    if (!target) return () => {};
    const { tf } = target;

    let cancelled = false;
    let stop: (() => void) | undefined;

    ensureProvidersLoaded()
      // Not set up: getBars has already said so, so stay quiet here.
      .then(() => {
        if (!isProviderUsable(INDIA)) return null;
        let builder: LiveBarBuilder | null = null;
        return live(ticker, (tick) => {
          const bar = builder?.onTick(tick, Date.now());
          if (bar) onBar(bar);
        }).then((sub) => {
          if (!sub) return;
          builder = new LiveBarBuilder({
            tf,
            sessionOpenMin: sessionOpenForExchange(sub.exchange),
            seed: this.newestBar.get(`${ticker}|${timeframeToString(tf)}`) ?? null,
          });
          // Unsubscribed before the backend answered: hand the subscription straight back.
          if (cancelled) sub.stop();
          else stop = sub.stop;
        });
      })
      .catch((err) => notify('error', errorMessage(err)));

    return () => {
      cancelled = true;
      stop?.();
    };
  }
}
