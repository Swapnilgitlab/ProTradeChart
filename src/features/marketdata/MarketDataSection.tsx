import { Database, Download, RefreshCw, Square } from 'lucide-react';
import { describeHoldings, describeProgress, describeWhen, isDownloaded } from '../../lib/marketData';
import { useMarketData } from './useMarketData';

/** The local store of every NSE stock's daily history: its download, the daily update, and what it holds. */
export function MarketDataSection() {
  const { status, notice, download, updateNow, stop, setAuto } = useMarketData();
  if (!status) return null;
  const now = Date.now();
  const running = status.running;
  const downloaded = isDownloaded(status);

  return (
    <section className="prov-detail market-data" aria-label="Market data">
      <h3>
        <Database size={15} /> Market data on this computer
      </h3>
      <p className="secondary">
        Five years of daily prices for every NSE stock and index, downloaded once from your broker and kept up to date after
        each trading day. The Screener, Studies and Python scripts read it straight from disk instead of asking the broker
        symbol by symbol.
      </p>
      <div className="prov-status">
        <div className="prov-status-row">
          <div>
            <div className="label">Stored</div>
            <div>{running ? describeProgress(running.progress) : describeHoldings(status, now)}</div>
            {status.lastError && !running && (
              <div className="neg">
                Last update failed{status.lastFailure ? ` (${describeWhen(status.lastFailure, now)})` : ''}: {status.lastError}
              </div>
            )}
            {notice && <div className={notice.error ? 'neg' : undefined}>{notice.text}</div>}
          </div>
          {running ? (
            <button type="button" className="btn" onClick={() => void stop()}>
              <Square size={13} /> Stop
            </button>
          ) : downloaded ? (
            <button type="button" className="btn" onClick={() => void updateNow()}>
              <RefreshCw size={13} /> Update now
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => void download()}>
              <Download size={13} /> {status.provider ? 'Resume download' : 'Download'}
            </button>
          )}
        </div>
        <label className="prov-status-row market-data-auto">
          <span>
            <span className="label">Update after each trading day</span>
            <span className="secondary small">
              While the app is open, after 4 PM IST. Charts always go first; the update waits its turn at the broker.
            </span>
          </span>
          <input type="checkbox" checked={status.autoUpdate} onChange={(e) => void setAuto(e.target.checked)} />
        </label>
      </div>
      {!downloaded && !running && (
        <p className="secondary small">
          The first download takes about 10–15 minutes at the broker&rsquo;s pace and can be stopped and resumed. Charts keep
          working while it runs.
        </p>
      )}
    </section>
  );
}
