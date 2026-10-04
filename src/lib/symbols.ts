/** A chart symbol is always `provider:TICKER` — the provider prefix is what
 *  tells Vela (and this app) which data source serves it. */

export type ProviderId = 'csv' | 'zerodha';

/** What a bare ticker means: NSE, through the user's own Zerodha account. */
export const DEFAULT_PROVIDER: ProviderId = 'zerodha';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  csv: 'Imported',
  zerodha: 'Zerodha',
};

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
  return { provider: trimmed.slice(0, i).toLowerCase(), ticker: trimmed.slice(i + 1) };
}

export function joinSymbol(provider: string, ticker: string): string {
  return `${provider.toLowerCase()}:${ticker}`;
}

/** The brokers list several exchanges and take the exchange as part of the ticker
 *  (`NSE:RELIANCE`, `BSE:RELIANCE`). */
const BROKERS = new Set(['zerodha']);

/** The exchange a broker assumes when a ticker names none — and so the one people
 *  never need to see: `NSE:` is dropped from everything on screen, other exchanges
 *  (`BSE:`, `NFO:`, `MCX:`) stay because `BSE:RELIANCE` is a different instrument. */
const IMPLIED_EXCHANGE = 'NSE:';

const hasImpliedExchange = (ticker: string) =>
  ticker.length > IMPLIED_EXCHANGE.length && ticker.slice(0, IMPLIED_EXCHANGE.length).toUpperCase() === IMPLIED_EXCHANGE;

/** The canonical `provider:TICKER` form of whatever the user or Vela handed us. A
 *  broker ticker with no exchange means NSE, so it is spelled out: `zerodha:HFCL`
 *  and `zerodha:NSE:HFCL` are one instrument and must be one string, or a watchlist
 *  row, an alert and a chart would each think they were looking at something else. */
export function normalizeSymbol(symbol: string): string {
  const { provider, ticker } = splitSymbol(symbol);
  const spelledOut = BROKERS.has(provider) && ticker !== '' && !ticker.includes(':') ? `${IMPLIED_EXCHANGE}${ticker}` : ticker;
  return joinSymbol(provider, spelledOut);
}

/** The ticker as people write it: no data source, and no exchange when it is the
 *  usual one — `zerodha:NSE:HFCL` reads `HFCL`, `zerodha:BSE:HFCL` reads `BSE:HFCL`. */
export function displayTicker(symbol: string): string {
  const { provider, ticker } = splitSymbol(symbol);
  return BROKERS.has(provider) && hasImpliedExchange(ticker) ? ticker.slice(IMPLIED_EXCHANGE.length) : ticker;
}

/** The form a chart is given. Vela writes a chart's title, status line and watermark
 *  from the ticker part of the symbol it was handed, so handing it `zerodha:HFCL`
 *  rather than `zerodha:NSE:HFCL` is what keeps the exchange off the chart. The
 *  backends read the short form as NSE, so it loads the same instrument; anything
 *  Vela reports back goes through `normalizeSymbol` to become the long form again. */
export function chartSymbol(symbol: string): string {
  const { provider } = splitSymbol(symbol);
  return joinSymbol(provider, displayTicker(symbol));
}

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider as ProviderId] ?? provider;
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
 *  goes to `defaultProvider`; a known `provider:` prefix is honoured. The ticker
 *  is upper-cased: every supported source uses upper-case tickers. Returns
 *  `null` for empty input. */
export function resolveTypedSymbol(text: string, defaultProvider: ProviderId = DEFAULT_PROVIDER): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const colon = trimmed.indexOf(':');
  const prefix = colon > 0 ? trimmed.slice(0, colon).toLowerCase() : '';
  const explicit = prefix in PROVIDER_LABELS;
  const provider = explicit ? prefix : defaultProvider;
  // Without a known prefix the whole text is the ticker: `NSE:RELIANCE` is a
  // broker-style ticker, not a provider called "nse".
  const ticker = (explicit ? trimmed.slice(colon + 1) : trimmed).trim().toUpperCase();
  if (!ticker) return null;

  // Brokers that list several exchanges want one named; NSE is the usual intent.
  const needsExchange = provider === 'zerodha' && !ticker.includes(':');
  return joinSymbol(provider, needsExchange ? `NSE:${ticker}` : ticker);
}
