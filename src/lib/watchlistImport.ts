import { canonicalProvider, INDIA, isSupportedProvider, joinSymbol, resolveTypedSymbol, type ProviderId } from './symbols';

export interface ImportedWatchlistItem {
  symbol: string;
  name?: string;
}

export interface WatchlistImportResult {
  items: ImportedWatchlistItem[];
  /** Entries that could not be turned into a chartable symbol. */
  skipped: string[];
}

export interface MapOptions {
  /** Whether NSE and BSE symbols can be charted: a broker account is set up to serve
   *  them (`india:NSE:RELIANCE`). With none, they can't be charted and are skipped. */
  indian?: boolean;
  /** Where an entry with no exchange goes (default: the app's default provider). */
  defaultProvider?: ProviderId;
}

/** TradingView's NSE index shorthands → the app's ticker for the index (index names have
 *  spaces, which tickers write as underscores). */
const INDIA_INDEX: Record<string, string> = {
  NIFTY: 'NIFTY_50',
  NIFTY50: 'NIFTY_50',
  BANKNIFTY: 'NIFTY_BANK',
};

/** Maps one `EXCHANGE:TICKER` (TradingView) or bare `TICKER` entry to this
 *  app's `provider:TICKER`, or `null` if it can't be charted — an exchange none
 *  of the app's data sources covers (crypto, US and most world stocks, FX, futures). */
export function mapSymbol(entry: string, options: MapOptions = {}): string | null {
  const raw = entry.trim().replace(/^["']|["']$/g, '');
  if (!raw) return null;

  const colon = raw.indexOf(':');
  if (colon < 0) return /^[A-Za-z0-9^.=_-]+$/.test(raw) ? resolveTypedSymbol(raw, options.defaultProvider) : null;

  const prefix = raw.slice(0, colon).trim();
  const ticker = raw.slice(colon + 1).trim();
  if (!prefix || !ticker) return null;

  const exchange = prefix.toUpperCase();
  const lowerPrefix = prefix.toLowerCase();
  const upper = ticker.toUpperCase();

  // Already one of our own provider:TICKER symbols (e.g. a re-imported export, or one saved
  // under a broker's name). Our prefixes are lowercase; TradingView's exchange codes are uppercase.
  const ours = canonicalProvider(lowerPrefix);
  if (prefix === lowerPrefix && isSupportedProvider(ours)) {
    return joinSymbol(ours as ProviderId, ours === 'csv' ? upper : ticker);
  }

  if ((exchange === 'NSE' || exchange === 'BSE') && options.indian) {
    return joinSymbol(INDIA, `${exchange}:${(exchange === 'NSE' && INDIA_INDEX[upper]) || upper}`);
  }
  return null;
}

const SYMBOL_HEADERS = ['symbol', 'ticker', 'symbols', 'tickers', 'instrument', 'code'];
const NAME_HEADERS = ['name', 'company', 'description', 'company name'];

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if ((ch === ',' || ch === ';' || ch === '\t') && !quoted) {
      out.push(field.trim());
      field = '';
    } else field += ch;
  }
  out.push(field.trim());
  return out;
}

/** Parses a watchlist file. Two shapes are understood:
 *   - a TradingView export: `NSE:RELIANCE,NASDAQ:AAPL,###SECTION,…`, split on
 *     commas and/or newlines (`###` lines are section headings and ignored);
 *   - a CSV whose header names a Symbol/Ticker column (and optionally a Name). */
export function parseWatchlistFile(text: string, options: MapOptions = {}): WatchlistImportResult {
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  const items: ImportedWatchlistItem[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  const push = (entry: string, name?: string) => {
    if (entry.startsWith('###')) return; // TradingView section heading
    const symbol = mapSymbol(entry, options);
    if (!symbol) {
      if (entry.trim()) skipped.push(entry.trim());
      return;
    }
    if (seen.has(symbol)) return;
    seen.add(symbol);
    items.push(name ? { symbol, name } : { symbol });
  };

  if (lines.length > 0) {
    const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
    const symbolCol = header.findIndex((h) => SYMBOL_HEADERS.includes(h));
    if (symbolCol >= 0 && lines.length > 1) {
      const nameCol = header.findIndex((h) => NAME_HEADERS.includes(h));
      for (const line of lines.slice(1)) {
        const cells = splitCsvLine(line);
        push(cells[symbolCol] ?? '', nameCol >= 0 ? cells[nameCol] || undefined : undefined);
      }
      return { items, skipped };
    }
  }

  for (const line of lines) for (const entry of line.split(',')) push(entry);
  return { items, skipped };
}
