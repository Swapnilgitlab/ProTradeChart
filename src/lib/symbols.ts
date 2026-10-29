/** A chart symbol is always `provider:TICKER` — the provider prefix is what
 *  tells Vela (and this app) which data source serves it. */

export type ProviderId = 'csv' | 'india';

/** The namespace every Indian market symbol lives in (`india:NSE:RELIANCE`), whichever broker serves it. Which one
 *  does is a setting (`activeBroker` in `data/providerStatus`), so a symbol never names a broker. */
export const INDIA = 'india';

/** The brokers that can serve `india:` symbols. These are settings and accounts (`provider_settings`, the keychain),
 *  never symbol prefixes. */
export type BrokerId = 'zerodha' | 'fyers';

export const BROKER_LABELS: Record<BrokerId, string> = {
  zerodha: 'Zerodha',
  fyers: 'FYERS',
};

/** What a bare ticker means: NSE, through whichever broker the user connected. */
export const DEFAULT_PROVIDER: ProviderId = INDIA;

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  csv: 'Imported',
  india: 'Indian markets',
};

/** Older spellings of the Indian namespace: symbols saved while it was named after the one broker that served it
 *  (`zerodha:NSE:HFCL`), and a broker's name typed by hand. They read as `india:` everywhere, because every symbol
 *  passes through `splitSymbol`. */
const ALIASES: Record<string, ProviderId> = { zerodha: INDIA, fyers: INDIA };

/** The provider a prefix stands for, lower-cased, with the old spellings mapped to `india`. */
export function canonicalProvider(provider: string): string {
  const lower = provider.toLowerCase();
  return ALIASES[lower] ?? lower;
}

/** `symbol` with an old spelling of its prefix replaced (`zerodha:NSE:X` → `india:NSE:X`) and nothing else changed —
 *  not the case, not a short ticker. What a Study's or a screen's validator does to the symbols it's given, the same
 *  rule as the engine's `canonical_symbol_prefix` (`protrade/api.py`). */
export function withCanonicalPrefix(symbol: string): string {
  const i = symbol.indexOf(':');
  if (i <= 0) return symbol;
  const alias = ALIASES[symbol.slice(0, i).toLowerCase()];
  return alias ? `${alias}${symbol.slice(i)}` : symbol;
}

export interface ParsedSymbol {
  provider: string;
  ticker: string;
}

/** Splits `provider:TICKER`. A bare ticker falls back to the default provider.
 *  Only the FIRST colon separates, so tickers containing one survive intact. */
export function splitSymbol(symbol: string): ParsedSymbol {
  const trimmed = symbol.trim();
  const i = trimmed.indexOf(':');
  if (i <= 0) return { provider: DEFAULT_PROVIDER, ticker: trimmed };
  return { provider: canonicalProvider(trimmed.slice(0, i)), ticker: trimmed.slice(i + 1) };
}

export function joinSymbol(provider: string, ticker: string): string {
  return `${provider.toLowerCase()}:${ticker}`;
}

/** The Indian namespace lists several exchanges and takes the exchange as part of the ticker
 *  (`NSE:RELIANCE`, `BSE:RELIANCE`). */
const HAS_EXCHANGES = new Set<string>([INDIA]);

/** The exchange a broker assumes when a ticker names none — and so the one people
 *  never need to see: `NSE:` is dropped from everything on screen, other exchanges
 *  (`BSE:`, `NFO:`, `MCX:`) stay because `BSE:RELIANCE` is a different instrument. */
const IMPLIED_EXCHANGE = 'NSE:';

const hasImpliedExchange = (ticker: string) =>
  ticker.length > IMPLIED_EXCHANGE.length && ticker.slice(0, IMPLIED_EXCHANGE.length).toUpperCase() === IMPLIED_EXCHANGE;

/** The canonical `provider:TICKER` form of whatever the user or Vela handed us. A
 *  broker ticker with no exchange means NSE, so it is spelled out: `india:HFCL`
 *  and `india:NSE:HFCL` are one instrument and must be one string, or a watchlist
 *  row, an alert and a chart would each think they were looking at something else. */
export function normalizeSymbol(symbol: string): string {
  const { provider, ticker } = splitSymbol(symbol);
  const spelledOut = HAS_EXCHANGES.has(provider) && ticker !== '' && !ticker.includes(':') ? `${IMPLIED_EXCHANGE}${ticker}` : ticker;
  return joinSymbol(provider, spelledOut);
}

/** The ticker as people write it: no data source, and no exchange when it is the
 *  usual one — `india:NSE:HFCL` reads `HFCL`, `india:BSE:HFCL` reads `BSE:HFCL`. */
export function displayTicker(symbol: string): string {
  const { provider, ticker } = splitSymbol(symbol);
  return HAS_EXCHANGES.has(provider) && hasImpliedExchange(ticker) ? ticker.slice(IMPLIED_EXCHANGE.length) : ticker;
}

/** The form a chart is given. Vela writes a chart's title, status line and watermark
 *  from the ticker part of the symbol it was handed, so handing it `india:HFCL`
 *  rather than `india:NSE:HFCL` is what keeps the exchange off the chart. The
 *  backends read the short form as NSE, so it loads the same instrument; anything
 *  Vela reports back goes through `normalizeSymbol` to become the long form again. */
export function chartSymbol(symbol: string): string {
  const { provider } = splitSymbol(symbol);
  return joinSymbol(provider, displayTicker(symbol));
}

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[canonicalProvider(provider) as ProviderId] ?? provider;
}

/** Whether the app has a data source of this name. A saved layout, watchlist or alert can
 *  hold a symbol from a source that has since been removed; it can't be loaded. */
export function isSupportedProvider(provider: string): provider is ProviderId {
  return provider in PROVIDER_LABELS;
}

export function isSupportedSymbol(symbol: string): boolean {
  return isSupportedProvider(splitSymbol(symbol).provider);
}

/** Turns whatever a user typed into a `provider:TICKER` symbol. A bare ticker
 *  goes to `defaultProvider`; a known `provider:` prefix is honoured (a broker's name
 *  reads as the Indian namespace). The ticker is upper-cased: every supported source
 *  uses upper-case tickers. Returns `null` for empty input. */
export function resolveTypedSymbol(text: string, defaultProvider: ProviderId = DEFAULT_PROVIDER): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const colon = trimmed.indexOf(':');
  const prefix = colon > 0 ? canonicalProvider(trimmed.slice(0, colon)) : '';
  const explicit = prefix in PROVIDER_LABELS;
  const provider = explicit ? prefix : defaultProvider;
  // Without a known prefix the whole text is the ticker: `NSE:RELIANCE` is a
  // broker-style ticker, not a provider called "nse".
  const ticker = (explicit ? trimmed.slice(colon + 1) : trimmed).trim().toUpperCase();
  if (!ticker) return null;

  // The Indian namespace lists several exchanges and wants one named; NSE is the usual intent.
  const needsExchange = HAS_EXCHANGES.has(provider) && !ticker.includes(':');
  return joinSymbol(provider, needsExchange ? `NSE:${ticker}` : ticker);
}
