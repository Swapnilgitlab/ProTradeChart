import type { DataProvider } from '@luxalgo/vela';
import { BinanceProvider } from '@luxalgo/vela/providers/binance';
import { CoinbaseProvider } from '@luxalgo/vela/providers/coinbase';
import { HyperliquidProvider } from '@luxalgo/vela/providers/hyperliquid';
import { CsvProvider } from './csv';
import { DhanProvider } from './dhan';
import { ZerodhaProvider } from './zerodha';
import { joinSymbol, normalizeSymbol, type ProviderId } from '../../lib/symbols';
import { publishLivePrice } from '../livePrices';

/** One instance of each provider, shared by every chart tab AND by symbol
 *  search / watchlist quotes. Sharing matters: the crypto providers cache
 *  their (large) symbol lists internally, so a second instance would download
 *  them again.
 *
 *  Every provider is always registered with Vela, whether or not it's switched
 *  on: a saved layout can hold a symbol from a provider that has since been
 *  turned off, and it should say so (each provider guards itself) rather than
 *  fail to resolve. Whether a provider is *offered* — in search, watchlists —
 *  is decided by `data/providerStatus`. */
const instances: Record<ProviderId, DataProvider> = {
  binance: withLivePriceTap('binance', withoutRemoteIcons(new BinanceProvider())),
  coinbase: withLivePriceTap('coinbase', withoutRemoteIcons(new CoinbaseProvider())),
  hyperliquid: withLivePriceTap('hyperliquid', withoutRemoteIcons(new HyperliquidProvider())),
  csv: new CsvProvider(),
  dhan: withLivePriceTap('dhan', new DhanProvider()),
  zerodha: withLivePriceTap('zerodha', new ZerodhaProvider()),
};

/** Registered with every VelaWorkspace as `providers` — the keys are the
 *  `provider:` prefixes symbols carry. */
export const providerFactories: Record<ProviderId, () => DataProvider> = {
  binance: () => instances.binance,
  coinbase: () => instances.coinbase,
  hyperliquid: () => instances.hyperliquid,
  csv: () => instances.csv,
  dhan: () => instances.dhan,
  zerodha: () => instances.zerodha,
};

/** Vela's crypto providers give each coin the logo from Ledger's icon server. Fetching
 *  it would tell a third party the user never chose which coins they look at, so the
 *  symbol shows Vela's two-letter badge instead (the CSP blocks remote images anyway). */
function withoutRemoteIcons<T extends DataProvider>(provider: T): T {
  provider.resolveSymbolIcon = () => undefined;
  return provider;
}

/** Every bar a provider streams to a chart also goes to `livePrices`, so a tab can show the price of its symbol as it
 *  trades without a request of its own. The chart gets the bar exactly as before. A provider that doesn't stream
 *  (Vela polls it) is left alone. */
function withLivePriceTap<T extends DataProvider>(id: ProviderId, provider: T): T {
  const stream = provider as DataProvider;
  const subscribe = stream.subscribe;
  if (!subscribe) return provider;
  stream.subscribe = (ticker, timeframe, onBar, opts) =>
    subscribe.call(
      provider,
      ticker,
      timeframe,
      (bar) => {
        // Whatever form the chart's ticker is in (`HFCL`, `NSE:HFCL`), the canonical symbol is what a tab holds.
        publishLivePrice(normalizeSymbol(joinSymbol(id, ticker)), bar.close);
        onBar(bar);
      },
      opts,
    );
  return provider;
}

export function getProvider(id: string): DataProvider | undefined {
  return (instances as Record<string, DataProvider>)[id];
}
