/** A chart symbol is always `provider:TICKER` — the provider prefix is what
 *  tells Vela (and this app) which data source serves it. */

export type ProviderId = 'yahoo' | 'binance' | 'coinbase' | 'hyperliquid' | 'csv' | 'dhan' | 'zerodha';

export const DEFAULT_PROVIDER: ProviderId = 'yahoo';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  yahoo: 'Yahoo Finance',
  binance: 'Binance',
  coinbase: 'Coinbase',
  hyperliquid: 'Hyperliquid',
  csv: 'Imported',
  dhan: 'Dhan',
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

/** The canonical `provider:TICKER` form of whatever the user or Vela handed us. */
export function normalizeSymbol(symbol: string): string {
  const { provider, ticker } = splitSymbol(symbol);
  return joinSymbol(provider, ticker);
}

/** The short label for tabs and lists: the ticker without its provider. */
export function displayTicker(symbol: string): string {
  return splitSymbol(symbol).ticker;
}

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider as ProviderId] ?? provider;
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
  const needsExchange = (provider === 'dhan' || provider === 'zerodha') && !ticker.includes(':');
  return joinSymbol(provider, needsExchange ? `NSE:${ticker}` : ticker);
}
