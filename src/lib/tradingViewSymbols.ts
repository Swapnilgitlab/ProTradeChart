import { INDIA, joinSymbol, normalizeSymbol, splitSymbol } from './symbols';

/** The app's ticker for an NSE index (the broker's spelling) → TradingView's, where the two differ. From
 *  TradingView's own list of the NSE indices it carries volume for. An index not here is spelled the same on
 *  both (`NIFTY_HEALTHCARE`), or TradingView's spelling isn't known and it goes out as the app spells it. */
export const TRADINGVIEW_NSE_INDEX: Readonly<Record<string, string>> = {
  NIFTY_50: 'NIFTY',
  NIFTY_BANK: 'BANKNIFTY',
  NIFTY_NEXT_50: 'NIFTYJR',
  NIFTY_200: 'CNX200',
  NIFTY_500: 'CNX500',
  NIFTY_MIDCAP_50: 'NIFTYMIDCAP50',
  NIFTY_MIDCAP_100: 'CNXMIDCAP',
  NIFTY_SMLCAP_100: 'CNXSMALLCAP',
  NIFTY_AUTO: 'CNXAUTO',
  NIFTY_ENERGY: 'CNXENERGY',
  NIFTY_FIN_SERVICE: 'CNXFINANCE',
  NIFTY_FINSRV25_50: 'NIFTYFINSRV25_50',
  NIFTY_FMCG: 'CNXFMCG',
  NIFTY_INFRA: 'CNXINFRA',
  NIFTY_IT: 'CNXIT',
  NIFTY_MEDIA: 'CNXMEDIA',
  NIFTY_METAL: 'CNXMETAL',
  NIFTY_PHARMA: 'CNXPHARMA',
  NIFTY_PSU_BANK: 'CNXPSUBANK',
  NIFTY_PVT_BANK: 'NIFTYPVTBANK',
  NIFTY_REALTY: 'CNXREALTY',
};

/** TradingView's spelling of an NSE index → the app's: the table above turned round, and `NIFTY50`, which
 *  older TradingView lists use. */
export const FROM_TRADINGVIEW_NSE_INDEX: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(TRADINGVIEW_NSE_INDEX).map(([ours, theirs]) => [theirs, ours])),
  NIFTY50: 'NIFTY_50',
};

/** The exchanges whose tickers TradingView writes as the brokers do. F&O and commodity contracts are named
 *  differently there (`NIFTY1!`), so they have no TradingView form here. */
const SAME_TICKERS = new Set(['NSE', 'BSE']);

/** `india:NSE:RELIANCE` → `NSE:RELIANCE`, as TradingView names it; `null` when TradingView has no equivalent:
 *  an imported data file's symbol, a futures or options contract, a source the app no longer has. */
export function tradingViewSymbol(symbol: string): string | null {
  const { provider, ticker } = splitSymbol(normalizeSymbol(symbol));
  if (provider !== INDIA) return null;
  // After `normalizeSymbol` an Indian ticker names its exchange, unless it is empty.
  const colon = ticker.indexOf(':');
  if (colon <= 0) return null;
  const exchange = ticker.slice(0, colon).toUpperCase();
  const name = ticker.slice(colon + 1).toUpperCase();
  if (!SAME_TICKERS.has(exchange) || !name) return null;
  return `${exchange}:${(exchange === 'NSE' && TRADINGVIEW_NSE_INDEX[name]) || name}`;
}

/** The app's symbol for TradingView's `NSE:CNXIT` / `BSE:RELIANCE` (exchange and ticker already split and
 *  upper-cased). */
export function fromTradingView(exchange: 'NSE' | 'BSE', ticker: string): string {
  return joinSymbol(INDIA, `${exchange}:${(exchange === 'NSE' && FROM_TRADINGVIEW_NSE_INDEX[ticker]) || ticker}`);
}
