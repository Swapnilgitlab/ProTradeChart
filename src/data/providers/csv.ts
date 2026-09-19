import type { BarRange, DataProvider, OHLCV, ProviderInfo, SymbolDescriptor } from '@luxalgo/vela';
import { getDatasetBars, listDatasets } from '../../lib/ipc';
import { localDayKey, parseTimeframe, resampleTo } from '../../lib/timeframes';
import { notify } from '../events';

/** Serves the OHLCV files a user imported (see `ImportDataDialog`). They live
 *  in the local database, so charts built on them work with no network at all.
 *
 *  A dataset has one native timeframe. Asking for a coarser one builds it by
 *  resampling; a finer one can't be invented, so that comes back empty with an
 *  explanation rather than a silently blank chart. */
export class CsvProvider implements DataProvider {
  info(): ProviderInfo {
    return {
      name: 'csv',
      displayName: 'Imported data',
      capabilities: { enumerate: true, stream: false, symbolInfo: false },
    };
  }

  async listSymbols(): Promise<SymbolDescriptor[]> {
    const datasets = await listDatasets();
    return datasets.map((d) => ({ ticker: d.ticker, description: d.description ?? undefined, type: 'imported' }));
  }

  async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
    const target = parseTimeframe(timeframe);
    if (!target) {
      notify('error', `Imported data can't serve the "${timeframe}" timeframe.`);
      return [];
    }

    // Resampling needs every source bar in the window, so the row limit is
    // applied after grouping rather than in the query.
    const dataset = await getDatasetBars(ticker, range.from, range.to, undefined);
    if (!dataset) {
      notify('error', `No imported dataset named "${ticker}". Import it from the Data menu.`);
      return [];
    }
    const source = parseTimeframe(dataset.baseTf);
    if (!source) return [];

    const raw: OHLCV[] = dataset.bars.map((b) => ({
      time: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume ?? undefined,
    }));

    const bars = resampleTo(raw, source, target, localDayKey);
    if (!bars) {
      notify('info', `${ticker} is stored at ${dataset.baseTf}; pick that timeframe or a coarser one.`);
      return [];
    }
    return range.limit !== undefined && bars.length > range.limit ? bars.slice(-range.limit) : bars;
  }
}
