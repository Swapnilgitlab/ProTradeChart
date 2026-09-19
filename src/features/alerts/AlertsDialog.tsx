import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Bell, Pause, Pencil, Play, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/Toasts';
import {
  CONDITION_LABELS,
  describeCondition,
  draftProblem,
  newAlert,
  parsePrice,
  roundForDisplay,
  suggestCondition,
  type AlertCondition,
  type AlertMode,
} from '../../alerts/logic';
import { soundEnabled, SOUND_PREFERENCE } from '../../alerts/notifier';
import type { AlertDraft } from '../../alerts/ui';
import { effectiveDefaultProvider, ensureProvidersLoaded } from '../../data/providerStatus';
import { fetchQuotes } from '../../data/quotes';
import { formatPrice } from '../../lib/format';
import {
  clearTriggeredPriceAlerts,
  deletePriceAlert,
  errorMessage,
  savePriceAlert,
  setPreference,
  type PriceAlert,
} from '../../lib/ipc';
import { displayTicker, providerLabel, resolveTypedSymbol, splitSymbol } from '../../lib/symbols';
import { useAlerts } from './useAlerts';

interface Props {
  /** Open straight onto a new-alert form for this symbol (and price), or on the list. */
  draft: AlertDraft | null;
  /** The symbol a new alert starts with when the dialog was opened on the list: the active chart's. */
  defaultSymbol: string;
  onClose: () => void;
}

interface FormSeed {
  /** Set when editing an existing alert. */
  alert?: PriceAlert;
  symbol: string;
  price: number | null;
}

/** A price as a plain string for an input: no thousands separators, no float noise. */
function priceText(value: number): string {
  return String(Number(value.toPrecision(10)));
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Statuses in the order people want to see them: what is watching first, what has fired last. */
const STATUS_ORDER = { active: 0, paused: 1, triggered: 2 } as const;

/** Price alerts: the list of what is being watched, and the form to add or edit one. */
export function AlertsDialog({ draft, defaultSymbol, onClose }: Props) {
  const [form, setForm] = useState<FormSeed | null>(draft ? { symbol: draft.symbol, price: draft.price ?? null } : null);
  return (
    <Dialog
      title={form ? (form.alert ? 'Edit alert' : 'New alert') : 'Price alerts'}
      onClose={onClose}
      wide={!form}
    >
      {form ? (
        <AlertForm
          key={form.alert?.id ?? 'new'}
          seed={form}
          onCancel={() => setForm(null)}
          onSaved={() => setForm(null)}
        />
      ) : (
        <AlertList onNew={() => setForm({ symbol: draft?.symbol ?? defaultSymbol, price: null })} onEdit={(alert) => setForm({ alert, symbol: alert.symbol, price: alert.price })} onClose={onClose} />
      )}
    </Dialog>
  );
}

function AlertList({ onNew, onEdit, onClose }: { onNew: () => void; onEdit: (alert: PriceAlert) => void; onClose: () => void }) {
  const toast = useToast();
  const { alerts } = useAlerts();
  const [sound, setSound] = useState(true);

  useEffect(() => {
    void soundEnabled().then(setSound);
  }, []);

  const sorted = useMemo(
    () =>
      [...alerts].sort(
        (a, b) =>
          STATUS_ORDER[a.status as keyof typeof STATUS_ORDER] - STATUS_ORDER[b.status as keyof typeof STATUS_ORDER] ||
          (b.triggeredAt ?? b.createdAt) - (a.triggeredAt ?? a.createdAt),
      ),
    [alerts],
  );
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
    <>
      <p className="secondary" style={{ marginTop: 0 }}>
        Get told when a price crosses a level. You can also right-click a chart and choose <strong>Add alert</strong>, or
        press <kbd>Alt</kbd>+<kbd>A</kbd>. Alerts are checked about every 20 seconds while the app is open.
      </p>

      {sorted.length === 0 ? (
        <div className="alert-empty">
          <Bell size={22} aria-hidden />
          <p>No alerts yet.</p>
        </div>
      ) : (
        <ul className="alert-list">
          {sorted.map((alert) => (
            <li key={alert.id} className={`alert-row ${alert.status}`}>
              <div className="alert-main">
                <div className="alert-title">
                  <strong>{displayTicker(alert.symbol)}</strong>
                  <span className="muted small">{providerLabel(splitSymbol(alert.symbol).provider)}</span>
                  <span>{describeCondition(alert.condition as AlertCondition, formatPrice(alert.price))}</span>
                </div>
                <div className="alert-sub small muted">{describeStatus(alert)}</div>
              </div>
              <div className="alert-actions">
                {alert.status === 'active' && (
                  <button type="button" className="icon-button" aria-label="Pause alert" title="Pause" onClick={() => void setStatus(alert, 'paused')}>
                    <Pause size={14} />
                  </button>
                )}
                {alert.status === 'paused' && (
                  <button type="button" className="icon-button" aria-label="Resume alert" title="Resume" onClick={() => void setStatus(alert, 'active')}>
                    <Play size={14} />
                  </button>
                )}
                {alert.status === 'triggered' && (
                  <button type="button" className="icon-button" aria-label="Re-arm alert" title="Watch for it again" onClick={() => void setStatus(alert, 'active')}>
                    <RotateCcw size={14} />
                  </button>
                )}
                <button type="button" className="icon-button" aria-label="Edit alert" title="Edit" onClick={() => onEdit(alert)}>
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Delete alert"
                  title="Delete"
                  onClick={() => void run(() => deletePriceAlert(alert.id))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="alert-footer">
        <label className="alert-sound">
          <input type="checkbox" checked={sound} onChange={(e) => toggleSound(e.currentTarget.checked)} /> Play a sound
        </label>
        <span className="grow" />
        {firedCount > 0 && (
          <button type="button" className="btn" onClick={() => void run(clearTriggeredPriceAlerts)}>
            Clear fired ({firedCount})
          </button>
        )}
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
        <button type="button" className="btn btn-primary" onClick={onNew}>
          <Plus size={13} /> New alert
        </button>
      </div>
    </>
  );
}

function describeStatus(alert: PriceAlert): string {
  const parts: string[] = [];
  if (alert.status === 'active') parts.push('Watching');
  else if (alert.status === 'paused') parts.push('Paused');
  else parts.push(`Fired ${alert.triggeredAt ? when(alert.triggeredAt) : ''} at ${alert.triggerPrice === null ? '—' : formatPrice(alert.triggerPrice)}`.replace('  ', ' '));
  if (alert.mode === 'every') {
    parts.push('every time it crosses');
    if (alert.status !== 'triggered' && alert.triggerCount > 0 && alert.triggeredAt) {
      parts.push(`fired ${alert.triggerCount}× (last ${when(alert.triggeredAt)})`);
    }
  }
  if (alert.message) parts.push(alert.message);
  return parts.join(' · ');
}

function AlertForm({ seed, onCancel, onSaved }: { seed: FormSeed; onCancel: () => void; onSaved: () => void }) {
  const toast = useToast();
  const editing = seed.alert;
  const [symbolText, setSymbolText] = useState(seed.symbol);
  // An existing alert's level is shown exactly; a price read off a chart is tidied.
  const [price, setPrice] = useState(
    seed.price === null ? '' : editing ? priceText(seed.price) : roundForDisplay(seed.price),
  );
  const [condition, setCondition] = useState<AlertCondition>((editing?.condition as AlertCondition) ?? 'crossing');
  const [conditionChosen, setConditionChosen] = useState(editing !== undefined);
  const [message, setMessage] = useState(editing?.message ?? '');
  const [mode, setMode] = useState<AlertMode>((editing?.mode as AlertMode) ?? 'once');
  const [current, setCurrent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [providersReady, setProvidersReady] = useState(false);
  useEffect(() => {
    void ensureProvidersLoaded().then(() => setProvidersReady(true));
  }, []);
  const symbol = useMemo(
    () => (providersReady ? resolveTypedSymbol(symbolText, effectiveDefaultProvider()) : null),
    [symbolText, providersReady],
  );

  // What the price is right now, to show and to measure the first crossing from.
  useEffect(() => {
    setCurrent(null);
    if (!symbol) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const quotes = await fetchQuotes([symbol]);
        if (!cancelled) setCurrent(quotes.get(symbol)?.price ?? null);
      } catch {
        // No current price: the alert still works, it just measures from its first sample.
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [symbol]);

  // Until the person picks a direction, follow the obvious one: a level above
  // the price waits for it to rise, one below waits for it to fall.
  const level = parsePrice(price);
  useEffect(() => {
    if (!conditionChosen && level !== null) setCondition(suggestCondition(level, current));
  }, [conditionChosen, level, current]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = draftProblem({ symbol: symbolText, price, message });
    if (problem || !symbol || level === null) {
      setError(problem ?? 'Choose a symbol for the alert.');
      return;
    }
    setBusy(true);
    try {
      const now = Date.now();
      const alert: PriceAlert = editing
        ? {
            ...editing,
            symbol,
            condition,
            price: level,
            message: message.trim(),
            mode,
            // Saving a fired alert puts it back to work; a changed level restarts the measuring.
            status: editing.status === 'triggered' ? 'active' : editing.status,
            basePrice: editing.price !== level || editing.condition !== condition || editing.status === 'triggered' ? current : editing.basePrice,
          }
        : newAlert({ id: crypto.randomUUID(), symbol, condition, price: level, basePrice: current, message, mode, now });
      await savePriceAlert(alert);
      toast(editing ? 'Alert updated.' : `Alert set: ${displayTicker(symbol)} ${describeCondition(condition, formatPrice(level)).toLowerCase()}.`, 'success');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="alert-form">
      <div className="field">
        <label htmlFor="alert-symbol">Symbol</label>
        <input
          id="alert-symbol"
          type="text"
          value={symbolText}
          placeholder="AAPL, BTCUSDT, dhan:NSE:RELIANCE…"
          autoComplete="off"
          spellCheck={false}
          autoFocus={!symbolText}
          onChange={(e) => setSymbolText(e.currentTarget.value)}
        />
        <span className="field-hint alert-current">
          {symbol ? (
            <>
              {providerLabel(splitSymbol(symbol).provider)}
              {current !== null ? <> · current price <strong>{formatPrice(current)}</strong></> : ' · looking up the current price…'}
            </>
          ) : (
            'The provider prefix is optional: a bare ticker goes to your default provider.'
          )}
        </span>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="alert-condition">Alert me when the price is</label>
          <select
            id="alert-condition"
            value={condition}
            onChange={(e) => {
              setCondition(e.currentTarget.value as AlertCondition);
              setConditionChosen(true);
            }}
          >
            {(Object.keys(CONDITION_LABELS) as AlertCondition[]).map((c) => (
              <option key={c} value={c}>
                {CONDITION_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="alert-price">Price</label>
          <input
            id="alert-price"
            type="text"
            inputMode="decimal"
            value={price}
            placeholder="0.00"
            autoComplete="off"
            autoFocus={!!symbolText}
            onChange={(e) => setPrice(e.currentTarget.value)}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="alert-mode">How often</label>
        <select id="alert-mode" value={mode} onChange={(e) => setMode(e.currentTarget.value as AlertMode)}>
          <option value="once">Only once</option>
          <option value="every">Every time it crosses (at most once a minute)</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor="alert-message">Note (optional)</label>
        <input
          id="alert-message"
          type="text"
          value={message}
          maxLength={200}
          placeholder="Shown when the alert fires"
          autoComplete="off"
          onChange={(e) => setMessage(e.currentTarget.value)}
        />
      </div>

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      <div className="alert-footer">
        <span className="grow" />
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Back
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save' : 'Create alert'}
        </button>
      </div>
    </form>
  );
}
