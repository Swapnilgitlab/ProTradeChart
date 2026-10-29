import type { DataProvider } from '@luxalgo/vela';
import { CsvProvider } from './csv';
import { IndiaProvider } from './india';
import { joinSymbol, normalizeSymbol, type ProviderId } from '../../lib/symbols';
import { publishLivePrice } from '../livePrices';

/** One instance of each provider, shared by every chart tab AND by symbol
 *  search / watchlist quotes.
 *
 *  Every provider is always registered with Vela, whether or not it's switched
 *  on: a saved layout can hold a symbol from a provider that has since been
 *  turned off, and it should say so (each provider guards itself) rather than
 *  fail to resolve. Whether a provider is *offered* — in search, watchlists —
 *  is decided by `data/providerStatus`. */
const india = withLivePriceTap('india', new IndiaProvider());

const instances: Record<ProviderId, DataProvider> = {
  csv: new CsvProvider(),
  india,
};

/** The Indian namespace under its old name, for text that reaches Vela without passing through `chartSymbol`: a Pine
 *  script's `request.security("zerodha:NSE:TCS")`, written before the namespace was renamed. It serves exactly what
 *  `india` does, but lists no symbols, so Vela's own symbol index holds each ticker once. */
const legacyIndia: DataProvider = {
  info: () => india.info(),
  getBars: (ticker, timeframe, range) => india.getBars(ticker, timeframe, range),
  subscribe: (ticker, timeframe, onBar) => india.subscribe(ticker, timeframe, onBar),
};

/** Registered with every VelaWorkspace as `providers` — the keys are the
 *  `provider:` prefixes symbols carry. */
export const providerFactories: Record<ProviderId | 'zerodha', () => DataProvider> = {
  csv: () => instances.csv,
  india: () => instances.india,
  zerodha: () => legacyIndia,
};

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
