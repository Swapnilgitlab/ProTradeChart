import { Database, RefreshCw, Square } from 'lucide-react';
import { describeHoldings, describeProgress, describeWhen } from '../../lib/marketData';
import { useMarketData } from './useMarketData';

/** "Keep the market loaded": every NSE stock's daily history, read into memory while the app is open. */
export function MarketDataSection() {
  const { status, notice, loadNow, stop, setKeepLoaded } = useMarketData();
  if (!status) return null;
  const now = Date.now();
  const running = status.running;

  return (
    <section className="prov-detail market-data" aria-label="Market data">
      <h3>
        <Database size={15} /> Market data
      </h3>
      <p className="secondary">
        Five years of daily prices for every NSE stock and index, read from your broker into memory while the app is open, so
        the Screener, Studies and Python scripts look at the whole market at once instead of asking the broker symbol by
        symbol. Nothing is saved on this computer: it is cleared when you close the app and read again the next time.
      </p>
      <div className="prov-status">
        <label className="prov-status-row market-data-auto">
          <span>
            <span className="label">Keep the market loaded</span>
            <span className="secondary small">
              Loads a couple of minutes after the app opens, then updates after each trading day (after 4 PM IST). Charts
              always go first; loading waits its turn at the broker.
            </span>
          </span>
          <input type="checkbox" checked={status.keepLoaded} onChange={(e) => void setKeepLoaded(e.target.checked)} />
        </label>
        <div className="prov-status-row">
          <div>
            <div className="label">In memory</div>
            <div>{running ? describeProgress(running.progress) : describeHoldings(status, now)}</div>
            {status.lastError && !running && (
              <div className="neg">
                Last load failed{status.lastFailure ? ` (${describeWhen(status.lastFailure, now)})` : ''}: {status.lastError}
              </div>
            )}
            {notice && <div className={notice.error ? 'neg' : undefined}>{notice.text}</div>}
          </div>
          {running ? (
            <button type="button" className="btn" onClick={() => void stop()}>
              <Square size={13} /> Stop
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => void loadNow()}>
              <RefreshCw size={13} /> {status.holdings.series > 0 ? 'Update now' : 'Load now'}
            </button>
          )}
        </div>
      </div>
      <p className="secondary small">
        A full load takes about 15 minutes at the broker&rsquo;s pace, and needs about 200 MB of memory. Screens on today&rsquo;s
        prices alone (the day&rsquo;s change, gap, volume) don&rsquo;t need it: they are judged on one quick quote of the whole
        market.
      </p>
    </section>
  );
}
