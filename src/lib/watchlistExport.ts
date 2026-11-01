import { tradingViewSymbol } from './tradingViewSymbols';
import type { Row } from './watchlistRows';

export interface TradingViewList {
  /** The file: `###SECTION,NSE:RELIANCE,NSE:TCS,…` on one line, as TradingView exports and imports a list. */
  text: string;
  /** How many symbols went into it. */
  count: number;
  /** Symbols TradingView has no equivalent for, left out (see `tradingViewSymbol`). */
  skipped: string[];
}

/** A watchlist in TradingView's watchlist format, in the list's own order. Section headings become `###NAME`
 *  entries, which TradingView reads as its own sections; a symbol it couldn't name is left out, never
 *  guessed at. */
export function tradingViewList(rows: readonly Row[]): TradingViewList {
  const entries: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'section') {
      // The entries are comma-separated, so a comma in a heading would cut it in two.
      entries.push(`###${row.name.replace(/[\s,]+/g, ' ').trim() || 'Section'}`);
      continue;
    }
    const symbol = tradingViewSymbol(row.symbol);
    if (!symbol) skipped.push(row.symbol);
    else if (!seen.has(symbol)) {
      seen.add(symbol);
      entries.push(symbol);
    }
  }
  return { text: entries.join(','), count: seen.size, skipped };
}
