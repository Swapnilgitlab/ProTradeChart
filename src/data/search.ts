import type { SymbolDescriptor } from '@luxalgo/vela';
import { listDatasets, zerodhaSearchInstruments } from '../lib/ipc';
import { joinSymbol, type ProviderId } from '../lib/symbols';
import { ensureProvidersLoaded, isProviderUsable } from './providerStatus';

export interface SymbolResult {
  /** Fully-qualified chart symbol, e.g. `zerodha:NSE:RELIANCE`. */
  symbol: string;
  ticker: string;
  provider: ProviderId;
  name?: string;
  /** Venue or instrument class, shown as a small tag (e.g. `NSE`, `Imported`). */
  tag?: string;
}

/** Search everything, or one provider only. */
export type SearchScope = 'all' | ProviderId;

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
  if (wants('zerodha')) jobs.push(zerodhaResults(q, size(ZERODHA_RESULTS)));

  const groups = await Promise.allSettled(jobs);
  return groups.flatMap((g) => (g.status === 'fulfilled' ? g.value : []));
}
