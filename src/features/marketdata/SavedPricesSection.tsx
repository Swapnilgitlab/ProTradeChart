import { HardDrive, Trash2 } from 'lucide-react';
import { describeSaved, describeSuppliers } from '../../lib/savedPrices';
import { useSavedPrices } from './useSavedPrices';

/** "Save prices on this computer": an opt-in copy of the broker's price history, so charts, screens,
 *  Studies and scripts start from it instead of asking the broker for everything again after each
 *  launch. One store whichever broker supplied the prices; off by default, and its terms notice is
 *  accepted before anything is saved. */
export function SavedPricesSection() {
  const { status, notice, busy, setOn, remove } = useSavedPrices();
  if (!status) return null;
  const suppliers = describeSuppliers(status);
  const showFile = status.on || status.bytes > 0;

  return (
    <section className="prov-detail market-data saved-prices" aria-label="Saved prices">
      <h3>
        <HardDrive size={15} /> Saved prices
      </h3>
      <p className="secondary">
        Off, the prices your broker sends are held in memory only and read again after every launch. On, they are also kept
        in a file on this computer: charts open from it, and the first screen, Study or script after a launch needs only
        today&rsquo;s prices from the broker, not every symbol&rsquo;s history. The prices are kept by symbol, not by
        broker, so they carry over if you change broker. Your broker&rsquo;s terms may restrict keeping copies of its
        data; you are asked to accept that before anything is saved.
      </p>
      <div className="prov-status">
        <label className="prov-status-row market-data-auto">
          <span>
            <span className="label">Save prices on this computer</span>
            <span className="secondary small">
              Daily prices are kept. Intraday ones are kept for a year, and only for charts and scripts that read them.
              Switching this off deletes the saved file.
            </span>
          </span>
          <input type="checkbox" checked={status.on} disabled={busy} onChange={(e) => void setOn(e.target.checked)} />
        </label>
        {showFile && (
          <div className="prov-status-row">
            <div>
              <div className="label">On this computer</div>
              <div>{describeSaved(status)}</div>
              {suppliers && <div className="secondary small">{suppliers}</div>}
              {status.problem && <div className="neg">{status.problem}</div>}
              {notice && <div className={notice.error ? 'neg' : undefined}>{notice.text}</div>}
            </div>
            {status.bytes > 0 && (
              <button type="button" className="btn" disabled={busy} onClick={() => void remove()}>
                <Trash2 size={13} /> Delete saved prices
              </button>
            )}
          </div>
        )}
        {!showFile && notice && (
          <div className="prov-status-row">
            <div className={notice.error ? 'neg' : undefined}>{notice.text}</div>
          </div>
        )}
      </div>
    </section>
  );
}
