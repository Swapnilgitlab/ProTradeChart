import { getWatchlist, studyEstimate } from '../../lib/ipc';
import { INDIA, splitSymbol } from '../../lib/symbols';
import type { UniverseEstimate } from '../../studies/readiness';
import type { StudySpec } from '../../studies/spec';

/** What loading a Study's (or a screen's) universe from `from` will cost (`study_estimate`: reads the database
 *  only). Null when a named watchlist doesn't exist. */
export async function estimateUniverse(
  u: Pick<StudySpec['universe'], 'source' | 'provider' | 'exchanges' | 'series' | 'watchlist' | 'symbols' | 'max_symbols'>,
  from: string,
  watchlists: readonly { id: number; name: string }[],
): Promise<UniverseEstimate | null> {
  let symbols: string[] | null = null;
  if (u.source === 'symbols') symbols = u.symbols;
  if (u.source === 'watchlist') {
    const row = watchlists.find((w) => w.name.toLowerCase() === (u.watchlist ?? '').toLowerCase());
    if (!row) return null;
    symbols = (await getWatchlist(row.id)).items.map((i) => i.symbol).filter((sym) => splitSymbol(sym).provider === INDIA);
  }
  return studyEstimate({
    provider: u.provider,
    exchanges: u.exchanges,
    series: u.series,
    symbols,
    // The first bar loaded, at midnight IST, as the engine asks for it.
    fromMs: Date.parse(`${from}T00:00:00+05:30`),
    maxSymbols: u.max_symbols,
  });
}
