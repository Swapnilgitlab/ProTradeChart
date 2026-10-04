import { useEffect, useMemo, useState, type FormEvent } from 'react';
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
import { effectiveDefaultProvider, ensureProvidersLoaded } from '../../data/providerStatus';
import { fetchQuotes } from '../../data/quotes';
import { formatPrice } from '../../lib/format';
import { errorMessage, savePriceAlert, type PriceAlert } from '../../lib/ipc';
import { displayTicker, providerLabel, resolveTypedSymbol, splitSymbol } from '../../lib/symbols';

/** What the form starts from: a new alert for a symbol (and perhaps a price), or an existing alert to edit. */
export interface AlertFormSeed {
  /** Set when editing an existing alert. */
  alert?: PriceAlert;
  symbol: string;
  price: number | null;
}

/** A price as a plain string for an input: no thousands separators, no float noise. */
function priceText(value: number): string {
  return String(Number(value.toPrecision(10)));
}

/** The form for one price alert — new or being edited — in a dialog. The list of alerts lives in the side
 *  panel (`AlertsPanel`); this is what opens from it, from a chart's right-click menu, or from `Alt+A`. */
export function AlertFormDialog({ seed, onClose }: { seed: AlertFormSeed; onClose: () => void }) {
  return (
    <Dialog title={seed.alert ? 'Edit alert' : 'New alert'} onClose={onClose}>
      <AlertForm seed={seed} onCancel={onClose} onSaved={onClose} />
    </Dialog>
  );
}

function AlertForm({ seed, onCancel, onSaved }: { seed: AlertFormSeed; onCancel: () => void; onSaved: () => void }) {
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
          placeholder="RELIANCE, zerodha:BSE:TCS…"
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
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save' : 'Create alert'}
        </button>
      </div>
    </form>
  );
}
