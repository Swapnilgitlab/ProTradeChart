import { useEffect, useMemo, useState } from 'react';
import { Bell, Pause, Pencil, Play, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useToast } from '../../components/Toasts';
import { describeCondition, type AlertCondition } from '../../alerts/logic';
import { soundEnabled, SOUND_PREFERENCE } from '../../alerts/notifier';
import { formatPrice } from '../../lib/format';
import {
  clearTriggeredPriceAlerts,
  deletePriceAlert,
  errorMessage,
  savePriceAlert,
  setPreference,
  type PriceAlert,
} from '../../lib/ipc';
import { displayTicker } from '../../lib/symbols';
import { describeStatus, sortAlerts } from './alertView';

interface Props {
  alerts: PriceAlert[];
  /** Click a row to chart the symbol it watches. */
  onSelectSymbol: (symbol: string) => void;
  onNew: () => void;
  onEdit: (alert: PriceAlert) => void;
}

/** Every price alert, docked beside the chart: what is being watched, what is paused, what has fired.
 *  Pausing, re-arming and deleting happen here; making or changing one opens the form. */
export function AlertsPanel({ alerts, onSelectSymbol, onNew, onEdit }: Props) {
  const toast = useToast();
  const [sound, setSound] = useState(true);

  useEffect(() => {
    void soundEnabled().then(setSound);
  }, []);

  const sorted = useMemo(() => sortAlerts(alerts), [alerts]);
  const firedCount = alerts.filter((a) => a.status === 'triggered').length;

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  /** Pausing keeps the alert; resuming or re-arming one starts measuring from the
   *  price at that moment (`basePrice: null` makes the engine take a fresh sample),
   *  so it doesn't fire at once over a move that happened while it was off. */
  const setStatus = (alert: PriceAlert, status: PriceAlert['status']) =>
    run(() => savePriceAlert({ ...alert, status, basePrice: status === 'active' ? null : alert.basePrice }));

  const toggleSound = (on: boolean) => {
    setSound(on);
    void setPreference(SOUND_PREFERENCE, on ? '1' : '0').catch(() => {});
  };

  return (
    <aside className="alerts-panel" aria-label="Price alerts">
      <div className="watchlist-header">
        <span className="panel-title">Alerts{alerts.length > 0 && <span className="panel-count">{alerts.length}</span>}</span>
        <div className="watchlist-header-actions">
          <button type="button" className="icon-button" aria-label="New alert" title="New alert (Alt+A)" onClick={onNew}>
            <Plus size={15} />
          </button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="panel-empty">
          <Bell size={22} aria-hidden />
          <span>No alerts yet. Right-click a chart and choose <strong>Add alert here…</strong>, or press <kbd>Alt</kbd>+<kbd>A</kbd>.</span>
          <button type="button" className="btn btn-primary" onClick={onNew}>
            <Plus size={14} /> New alert
          </button>
        </div>
      ) : (
        <ul className="alert-list alerts-panel-list">
          {sorted.map((alert) => (
            <li key={alert.id} className={`alert-row ${alert.status}`} onClick={() => onSelectSymbol(alert.symbol)}>
              <div className="alert-main">
                <div className="alert-title">
                  <strong title={alert.symbol}>{displayTicker(alert.symbol)}</strong>
                  <span>{describeCondition(alert.condition as AlertCondition, formatPrice(alert.price))}</span>
                </div>
                <div className="alert-sub small muted">{describeStatus(alert)}</div>
              </div>
              <div className="alert-actions" onClick={(e) => e.stopPropagation()}>
                {alert.status === 'active' && (
                  <button type="button" className="icon-button" aria-label="Pause alert" title="Pause" onClick={() => void setStatus(alert, 'paused')}>
                    <Pause size={13} />
                  </button>
                )}
                {alert.status === 'paused' && (
                  <button type="button" className="icon-button" aria-label="Resume alert" title="Resume" onClick={() => void setStatus(alert, 'active')}>
                    <Play size={13} />
                  </button>
                )}
                {alert.status === 'triggered' && (
                  <button type="button" className="icon-button" aria-label="Re-arm alert" title="Watch for it again" onClick={() => void setStatus(alert, 'active')}>
                    <RotateCcw size={13} />
                  </button>
                )}
                <button type="button" className="icon-button" aria-label="Edit alert" title="Edit" onClick={() => onEdit(alert)}>
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Delete alert"
                  title="Delete"
                  onClick={() => void run(() => deletePriceAlert(alert.id))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="alerts-panel-footer">
        <label className="alert-sound">
          <input type="checkbox" checked={sound} onChange={(e) => toggleSound(e.currentTarget.checked)} /> Play a sound
        </label>
        <span className="grow" />
        {firedCount > 0 && (
          <button type="button" className="btn btn-tiny" onClick={() => void run(clearTriggeredPriceAlerts)}>
            Clear fired ({firedCount})
          </button>
        )}
      </div>
    </aside>
  );
}
