import type { DataProvider, SymbolDescriptor } from '@luxalgo/vela';
import { dhanSearchInstruments, listDatasets, zerodhaSearchInstruments } from '../lib/ipc';
import { joinSymbol, type ProviderId } from '../lib/symbols';
import { getProvider } from './providers';
import { ensureProvidersLoaded, isProviderUsable } from './providerStatus';

export interface SymbolResult {
  /** Fully-qualified chart symbol, e.g. `binance:BTCUSDT`. */
  symbol: string;
  ticker: string;
  provider: ProviderId;
  name?: string;
  /** Venue or instrument class, shown as a small tag (e.g. `NASDAQ`, `Crypto`). */
  tag?: string;
}

/** Search everything, or one provider only. */
export type SearchScope = 'all' | ProviderId;

const CRYPTO_PROVIDERS: ProviderId[] = ['binance', 'coinbase', 'hyperliquid'];
const CRYPTO_RESULTS_PER_PROVIDER = 4;
const DHAN_RESULTS = 8;
const ZERODHA_RESULTS = 8;
const IMPORTED_RESULTS = 4;
/** With a single source picked there's room to show more of it. */
const SCOPED_RESULTS = 20;

/** Ranks how well a symbol matches a query: exact ticker beats a ticker prefix
 *  beats a ticker substring beats a description match. `null` = no match. */
export function matchScore(query: string, ticker: string, description?: string): number | null {
  const q = query.toLowerCase();
  const t = ticker.toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.includes(q)) return 2;
  if (description?.toLowerCase().includes(q)) return 3;
  return null;
}

/** Among equally good matches, the dollar-quoted pair (BTCUSDT, BTC-USD) is
 *  almost always the one someone means, ahead of BTCEUR or an odd BTCU. */
const DOLLAR_QUOTED = /(USDT|USDC|USD)$/;

/** Filters an enumerable provider's symbol list against a query, best match first. */
export function rankSymbols(query: string, symbols: SymbolDescriptor[], limit: number): SymbolDescriptor[] {
  const scored: { symbol: SymbolDescriptor; score: number; dollar: number }[] = [];
  for (const symbol of symbols) {
    const score = matchScore(query, symbol.ticker, symbol.description);
    if (score !== null) scored.push({ symbol, score, dollar: DOLLAR_QUOTED.test(symbol.ticker.toUpperCase()) ? 0 : 1 });
  }
  scored.sort((a, b) => a.score - b.score || a.dollar - b.dollar || a.symbol.ticker.length - b.symbol.ticker.length);
  return scored.slice(0, limit).map((s) => s.symbol);
}

async function dhanResults(query: string, limit: number): Promise<SymbolResult[]> {
  const matches = await dhanSearchInstruments(query, limit);
  return matches.map((m) => ({
    symbol: joinSymbol('dhan', m.symbol),
    ticker: m.symbol,
    provider: 'dhan',
    name: m.name ?? undefined,
    tag: m.kind === 'EQUITY' ? m.exchange ?? undefined : (m.kind ?? m.exchange ?? undefined),
  }));
}

async function zerodhaResults(query: string, limit: number): Promise<SymbolResult[]> {
  const matches = await zerodhaSearchInstruments(query, limit);
  return matches.map((m) => ({
    symbol: joinSymbol('zerodha', m.symbol),
    ticker: m.symbol,
    provider: 'zerodha',
    name: m.name ?? undefined,
    tag: m.kind === 'EQUITY' ? m.exchange ?? undefined : (m.kind ?? m.exchange ?? undefined),
  }));
}

async function enumerableResults(provider: ProviderId, query: string, limit: number): Promise<SymbolResult[]> {
  const source: DataProvider | undefined = getProvider(provider);
  if (!source?.listSymbols) return [];
  const symbols = await source.listSymbols(); // cached inside each provider after the first call
  return rankSymbols(query, symbols, limit).map((s) => ({
    symbol: joinSymbol(provider, s.ticker),
    ticker: s.ticker,
    provider,
    name: s.description,
    tag: 'Crypto',
  }));
}

async function importedResults(query: string, limit: number): Promise<SymbolResult[]> {
  const datasets = await listDatasets();
  const symbols: SymbolDescriptor[] = datasets.map((d) => ({ ticker: d.ticker, description: d.description ?? undefined }));
  return rankSymbols(query, symbols, limit).map((s) => ({
    symbol: joinSymbol('csv', s.ticker),
    ticker: s.ticker,
    provider: 'csv',
    name: s.description,
    tag: 'Imported',
  }));
}

/** Searches the providers that are switched on and set up — all of them, or just
 *  `scope`. A source that fails (offline, rate limited) just contributes
 *  nothing: one bad source never blanks the list. */
export async function searchSymbols(query: string, scope: SearchScope = 'all'): Promise<SymbolResult[]> {
  const q = query.trim();
  if (!q) return [];
  await ensureProvidersLoaded();

  const wants = (id: ProviderId) => (scope === 'all' || scope === id) && isProviderUsable(id);
  const size = (normal: number) => (scope === 'all' ? normal : SCOPED_RESULTS);

  const jobs: Promise<SymbolResult[]>[] = [];
  if (wants('csv')) jobs.push(importedResults(q, size(IMPORTED_RESULTS)));
  // Brokers first: someone who has set up their own account wants it ahead of the crypto lists.
  if (wants('dhan')) jobs.push(dhanResults(q, size(DHAN_RESULTS)));
  if (wants('zerodha')) jobs.push(zerodhaResults(q, size(ZERODHA_RESULTS)));
  for (const p of CRYPTO_PROVIDERS) if (wants(p)) jobs.push(enumerableResults(p, q, size(CRYPTO_RESULTS_PER_PROVIDER)));

  const groups = await Promise.allSettled(jobs);
  return groups.flatMap((g) => (g.status === 'fulfilled' ? g.value : []));
}
