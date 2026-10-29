import { marketQuotes } from '../lib/ipc';
import { INDIA, splitSymbol } from '../lib/symbols';
import { getProvider } from './providers';
import { ensureProvidersLoaded, isProviderUsable } from './providerStatus';

export interface QuoteView {
  price: number | null;
  changePercent: number | null;
}

const EMPTY: QuoteView = { price: null, changePercent: null };
/** How often a watchlist refreshes its prices. */
const QUOTE_REFRESH_MS = 20_000;
/** Sources whose whole list is quoted in a handful of requests (the Indian brokers batch
 *  them, and FYERS's are answered from one shared cache), or with no network at all
 *  (imported data). Everything else costs about one request per symbol. */
const CHEAP_TO_QUOTE = new Set([INDIA, 'csv']);
const MS_PER_UNBATCHED_SYMBOL = 700;
/** Crypto and imported-data quotes are derived from two daily bars each; cap how many run at once. */
const BAR_QUOTE_CONCURRENCY = 4;

/** How long a watchlist should wait between refreshes: a fixed 20 seconds,
 *  stretched for lists that contain many symbols quoted one request at a time
 *  so that a long crypto list doesn't hammer its venue. */
export function quoteRefreshMs(symbols: string[]): number {
  const unbatched = symbols.filter((s) => !CHEAP_TO_QUOTE.has(splitSymbol(s).provider)).length;
  return Math.max(QUOTE_REFRESH_MS, unbatched * MS_PER_UNBATCHED_SYMBOL);
}

/** Price and day change from the last two daily bars — the fallback for any
 *  source without a dedicated quote endpoint (crypto venues, imported data). */
export function quoteFromBars(closes: number[]): QuoteView {
  const price = closes.length > 0 ? closes[closes.length - 1] : null;
  const prev = closes.length > 1 ? closes[closes.length - 2] : null;
  const changePercent = price !== null && prev !== null && prev !== 0 ? ((price - prev) / prev) * 100 : null;
  return { price, changePercent };
}

async function quoteViaBars(symbol: string): Promise<QuoteView> {
  const { provider, ticker } = splitSymbol(symbol);
  const source = getProvider(provider);
  if (!source) return EMPTY;
  try {
    const bars = await source.getBars(ticker, 'D', { limit: 2 });
    return quoteFromBars(bars.map((b) => b.close));
  } catch {
    return EMPTY;
  }
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function mapLimited<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

/** One batched call to a provider's own quote endpoint, results in request order. */
async function batchQuotes(
  symbols: string[],
  out: Map<string, QuoteView>,
  fetch: (tickers: string[]) => Promise<{ price: number | null; changePercent: number | null; error: string | null }[]>,
): Promise<void> {
  if (symbols.length === 0) return;
  try {
    const quotes = await fetch(symbols.map((s) => splitSymbol(s).ticker));
    symbols.forEach((symbol, i) => {
      const q = quotes[i];
      out.set(symbol, q && !q.error ? { price: q.price, changePercent: q.changePercent } : EMPTY);
    });
  } catch {
    symbols.forEach((symbol) => out.set(symbol, EMPTY));
  }
}

/** Quotes for a list of `provider:TICKER` symbols, keyed by symbol. A symbol
 *  that can't be quoted is present with null fields, never missing. Symbols of
 *  a provider that is switched off (or not set up) are quoted as empty rather
 *  than triggering requests that would only fail. */
export async function fetchQuotes(symbols: string[]): Promise<Map<string, QuoteView>> {
  await ensureProvidersLoaded();
  const out = new Map<string, QuoteView>();
  const india: string[] = [];
  const other: string[] = [];
  for (const s of symbols) {
    const provider = splitSymbol(s).provider;
    if (!isProviderUsable(provider) && provider !== 'csv') out.set(s, EMPTY);
    else if (provider === INDIA) india.push(s);
    else other.push(s);
  }

  const otherJob = mapLimited(other, BAR_QUOTE_CONCURRENCY, async (symbol) => {
    out.set(symbol, await quoteViaBars(symbol));
  });

  await Promise.all([
    batchQuotes(india, out, marketQuotes),
    otherJob,
  ]);
  return out;
}
