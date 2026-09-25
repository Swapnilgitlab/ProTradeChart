import { listen } from '@tauri-apps/api/event';
import { fetchQuotes } from '../data/quotes';
import { ensureProvidersLoaded } from '../data/providerStatus';
import { listPriceAlerts, savePriceAlert, type PriceAlert } from '../lib/ipc';
import { announceAlert } from './notifier';
import { afterFiring, isActive, shouldFire } from './logic';

/** Watches the prices behind every active alert and fires the ones that cross.
 *
 *  It samples prices on a timer rather than streaming them: one source of
 *  prices (`fetchQuotes`) covers every provider, and a batch of symbols costs a
 *  request or two, so a few dozen alerts are cheap. A crossing is judged between
 *  two samples; the first sample after the app starts is compared with the
 *  alert's stored base price, so a level crossed while the app was closed still
 *  fires when it is next opened. */

export interface EngineDeps {
  list: () => Promise<PriceAlert[]>;
  save: (alert: PriceAlert) => Promise<void>;
  /** The latest price per symbol; a symbol that can't be priced maps to `null`. */
  prices: (symbols: string[]) => Promise<Map<string, number | null>>;
  onFire: (alert: PriceAlert, price: number) => void;
  now: () => number;
  log?: (message: string, error?: unknown) => void;
}

export class AlertEngine {
  /** The last price seen for each alert, so consecutive samples can be compared. */
  private readonly lastSeen = new Map<string, number>();
  private polling = false;

  constructor(private readonly deps: EngineDeps) {}

  /** One pass over the active alerts. Overlapping calls are dropped, not queued. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const active = (await this.deps.list()).filter(isActive);
      const ids = new Set(active.map((a) => a.id));
      for (const id of this.lastSeen.keys()) if (!ids.has(id)) this.lastSeen.delete(id);
      if (active.length === 0) return;

      const prices = await this.deps.prices([...new Set(active.map((a) => a.symbol))]);
      const now = this.deps.now();
      for (const alert of active) {
        const price = prices.get(alert.symbol);
        if (price === null || price === undefined || !Number.isFinite(price)) continue;
        await this.consider(alert, price, now);
      }
    } catch (err) {
      this.deps.log?.('alert check failed', err);
    } finally {
      this.polling = false;
    }
  }

  private async consider(alert: PriceAlert, price: number, now: number): Promise<void> {
    const remembered = this.lastSeen.get(alert.id);
    const previous = remembered ?? alert.basePrice;
    this.lastSeen.set(alert.id, price);

    if (previous === null) {
      // Nothing to compare with yet: remember where the price is, so the first
      // crossing is measured from here.
      await this.deps.save({ ...alert, basePrice: price }).catch((err) => this.deps.log?.('could not save', err));
      return;
    }
    if (!shouldFire(alert, previous, price, now)) return;

    const fired = afterFiring(alert, price, now);
    try {
      await this.deps.save(fired);
    } catch (err) {
      // Not saved means not fired: say nothing, and look at the same crossing again next time.
      this.deps.log?.('could not record a fired alert', err);
      if (remembered === undefined) this.lastSeen.delete(alert.id);
      else this.lastSeen.set(alert.id, remembered);
      return;
    }
    this.deps.onFire(fired, price);
  }
}

/** How often prices are sampled: the same cadence the watchlist refreshes at, so a
 *  data source isn't asked more often than the numbers change. */
const POLL_MS = 20_000;
/** Saving an alert (which the engine itself does when one fires) announces a
 *  change; wait for the burst to settle before looking again. */
const CHANGE_DEBOUNCE_MS = 400;

/** Starts watching. Returns a function that stops it. Runs in one window only —
 *  every window shares the same alerts, and two engines would each fire them. */
export function startAlertEngine(): () => void {
  const engine = new AlertEngine({
    list: listPriceAlerts,
    save: savePriceAlert,
    prices: async (symbols) => {
      await ensureProvidersLoaded();
      const quotes = await fetchQuotes(symbols);
      return new Map(symbols.map((s) => [s, quotes.get(s)?.price ?? null]));
    },
    onFire: (alert, price) => void announceAlert(alert, price),
    now: Date.now,
    log: (message, error) => console.warn(`[alerts] ${message}`, error),
  });

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let unlisten: (() => void) | undefined;

  const loop = async () => {
    await engine.poll();
    if (!stopped) timer = setTimeout(loop, POLL_MS);
  };
  void loop();

  void listen('alerts-changed', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => void engine.poll(), CHANGE_DEBOUNCE_MS);
  }).then((off) => {
    if (stopped) off();
    else unlisten = off;
  });

  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(debounce);
    unlisten?.();
  };
}
