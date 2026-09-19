import { joinSymbol, PROVIDER_LABELS, type ProviderId } from './symbols';

export interface ImportedWatchlistItem {
  symbol: string;
  name?: string;
}

export interface WatchlistImportResult {
  items: ImportedWatchlistItem[];
  /** Entries that could not be turned into a chartable symbol. */
  skipped: string[];
}

/** Yahoo ticker suffix per TradingView exchange code. */
const YAHOO_SUFFIX: Record<string, string> = {
  NSE: '.NS',
  BSE: '.BO',
  LSE: '.L',
  TSX: '.TO',
  TSXV: '.V',
  ASX: '.AX',
  SGX: '.SI',
  XETR: '.DE',
  FWB: '.F',
  EURONEXT: '.PA',
  MIL: '.MI',
  BME: '.MC',
  SIX: '.SW',
  OMXSTO: '.ST',
  OMXCOP: '.CO',
  OMXHEX: '.HE',
  TSE: '.T',
  KRX: '.KS',
  TWSE: '.TW',
  SSE: '.SS',
  SZSE: '.SZ',
  JSE: '.JO',
  BMFBOVESPA: '.SA',
};

/** US venues need no suffix. */
const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX', 'ARCA', 'CBOE', 'BATS', 'OTC', 'NYSEARCA']);

/** TradingView index/FX pseudo-exchanges → the Yahoo ticker that carries them. */
const YAHOO_INDEX: Record<string, string> = {
  SPX: '^GSPC',
  NDX: '^NDX',
  DJI: '^DJI',
  RUT: '^RUT',
  VIX: '^VIX',
  NI225: '^N225',
  UKX: '^FTSE',
  DAX: '^GDAXI',
  CAC40: '^FCHI',
  HSI: '^HSI',
  NIFTY: '^NSEI',
  NIFTY50: '^NSEI',
  BANKNIFTY: '^NSEBANK',
  SENSEX: '^BSESN',
  DXY: 'DX-Y.NYB',
  GOLD: 'GC=F',
  SILVER: 'SI=F',
  USOIL: 'CL=F',
};

const FX_EXCHANGES = new Set(['FX', 'FX_IDC', 'OANDA', 'FOREXCOM', 'FXCM', 'SAXO', 'PEPPERSTONE']);
const PASS_THROUGH_PROVIDERS = new Set<string>(Object.keys(PROVIDER_LABELS));

export interface MapOptions {
  /** Where NSE and BSE symbols go: Yahoo (`RELIANCE.NS`) or one of the user's
   *  own broker accounts (`dhan:NSE:RELIANCE`, `zerodha:NSE:RELIANCE`). */
  indianProvider?: 'yahoo' | 'dhan' | 'zerodha';
}

/** TradingView's index shorthands → the ticker Dhan's instrument list uses. */
const DHAN_INDEX: Record<string, string> = {
  NIFTY: 'NIFTY',
  NIFTY50: 'NIFTY',
  BANKNIFTY: 'NIFTY_BANK',
  SENSEX: 'SENSEX',
};

/** TradingView's NSE index shorthands → the ticker Zerodha's instrument list
 *  uses (its index names have spaces, which tickers write as underscores). */
const ZERODHA_INDEX: Record<string, string> = {
  NIFTY: 'NIFTY_50',
  NIFTY50: 'NIFTY_50',
  BANKNIFTY: 'NIFTY_BANK',
};

/** Splits a Coinbase pair like `BTCUSD` into Coinbase's `BTC-USD` form. */
function coinbasePair(ticker: string): string {
  if (ticker.includes('-')) return ticker;
  const m = /^(.+?)(USDT|USDC|USD|EUR|GBP|BTC|ETH)$/.exec(ticker);
  return m ? `${m[1]}-${m[2]}` : ticker;
}

function hongKongTicker(ticker: string): string {
  return /^\d+$/.test(ticker) ? `${ticker.padStart(4, '0')}.HK` : `${ticker}.HK`;
}

/** Maps one `EXCHANGE:TICKER` (TradingView) or bare `TICKER` entry to this
 *  app's `provider:TICKER`, or `null` if it can't be charted. */
export function mapSymbol(entry: string, options: MapOptions = {}): string | null {
  const raw = entry.trim().replace(/^["']|["']$/g, '');
  if (!raw) return null;

  const colon = raw.indexOf(':');
  if (colon < 0) return /^[A-Za-z0-9^.=\-_]+$/.test(raw) ? joinSymbol('yahoo', raw.toUpperCase()) : null;

  const prefix = raw.slice(0, colon).trim();
  const ticker = raw.slice(colon + 1).trim();
  if (!prefix || !ticker) return null;

  const exchange = prefix.toUpperCase();
  const lowerPrefix = prefix.toLowerCase();
  const upper = ticker.toUpperCase();

  // Already one of our own provider:TICKER symbols (e.g. a re-imported
  // export). Our prefixes are lowercase; TradingView's exchange codes are
  // uppercase, which is what keeps `coinbase:BTC-USD` and `COINBASE:BTCUSD`
  // (different ticker conventions) apart.
  if (prefix === lowerPrefix && PASS_THROUGH_PROVIDERS.has(lowerPrefix)) {
    return joinSymbol(lowerPrefix as ProviderId, lowerPrefix === 'csv' ? upper : ticker);
  }

  if (exchange === 'BINANCE') return joinSymbol('binance', upper);
  if (exchange === 'COINBASE') return joinSymbol('coinbase', coinbasePair(upper));
  if (exchange === 'HYPERLIQUID') return joinSymbol('hyperliquid', upper);

  if (FX_EXCHANGES.has(exchange)) return /^[A-Z]{6}$/.test(upper) ? joinSymbol('yahoo', `${upper}=X`) : null;
  if (exchange === 'HKEX') return joinSymbol('yahoo', hongKongTicker(upper));
  if (options.indianProvider === 'dhan' && (exchange === 'NSE' || exchange === 'BSE')) {
    const index = DHAN_INDEX[upper];
    return joinSymbol('dhan', index ? `IDX:${index}` : `${exchange}:${upper}`);
  }
  if (options.indianProvider === 'zerodha' && (exchange === 'NSE' || exchange === 'BSE')) {
    return joinSymbol('zerodha', `${exchange}:${(exchange === 'NSE' && ZERODHA_INDEX[upper]) || upper}`);
  }
  if (exchange in YAHOO_SUFFIX) {
    // NSE/BSE index shorthands share the exchange code with equities.
    if (upper in YAHOO_INDEX && (exchange === 'NSE' || exchange === 'BSE')) return joinSymbol('yahoo', YAHOO_INDEX[upper]);
    return joinSymbol('yahoo', `${upper}${YAHOO_SUFFIX[exchange]}`);
  }
  if (US_EXCHANGES.has(exchange)) return joinSymbol('yahoo', upper.replace(/\./g, '-'));
  if (upper in YAHOO_INDEX) return joinSymbol('yahoo', YAHOO_INDEX[upper]);

  // An unknown exchange is far more likely a real US-style ticker than a typo.
  return joinSymbol('yahoo', upper.replace(/\./g, '-'));
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
