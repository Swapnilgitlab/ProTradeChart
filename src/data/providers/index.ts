import type { DataProvider } from '@luxalgo/vela';
import { BinanceProvider } from '@luxalgo/vela/providers/binance';
import { CoinbaseProvider } from '@luxalgo/vela/providers/coinbase';
import { HyperliquidProvider } from '@luxalgo/vela/providers/hyperliquid';
import { CsvProvider } from './csv';
import { DhanProvider } from './dhan';
import { YahooProvider } from './yahoo';
import { ZerodhaProvider } from './zerodha';
import type { ProviderId } from '../../lib/symbols';

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
  yahoo: new YahooProvider(),
  binance: new BinanceProvider(),
  coinbase: new CoinbaseProvider(),
  hyperliquid: new HyperliquidProvider(),
  csv: new CsvProvider(),
  dhan: new DhanProvider(),
  zerodha: new ZerodhaProvider(),
};

/** Registered with every VelaWorkspace as `providers` — the keys are the
 *  `provider:` prefixes symbols carry. */
export const providerFactories: Record<ProviderId, () => DataProvider> = {
  yahoo: () => instances.yahoo,
  binance: () => instances.binance,
  coinbase: () => instances.coinbase,
  hyperliquid: () => instances.hyperliquid,
  csv: () => instances.csv,
  dhan: () => instances.dhan,
  zerodha: () => instances.zerodha,
};

export function getProvider(id: string): DataProvider | undefined {
  return (instances as Record<string, DataProvider>)[id];
}
