import type { LivePrice } from '../lib/tabQuote';

/** The latest price each streaming chart has delivered, by `provider:TICKER`.
 *
 *  A chart already receives every tick of its symbol; this lets the rest of the window (a tab's price) see the
 *  same ticks without asking the data source for anything more. The providers publish here as they stream
 *  (see `data/providers/index.ts`), and a component subscribes to the one symbol it shows. */

/** A busy market can tick many times a second; a label doesn't need to repaint that often. */
const NOTIFY_MS = 250;

const latest = new Map<string, LivePrice>();
const listeners = new Map<string, Set<() => void>>();
const notifying = new Set<string>();

/** Records the newest price of `symbol` (in its canonical `provider:TICKER` form). */
export function publishLivePrice(symbol: string, price: number, at: number = Date.now()): void {
  if (!Number.isFinite(price) || latest.get(symbol)?.price === price) return;
  latest.set(symbol, { price, at });
  // Nobody is showing it: nothing to tell. The price is kept for whoever subscribes next.
  if (!listeners.get(symbol)?.size || notifying.has(symbol)) return;
  notifying.add(symbol);
  setTimeout(() => {
    notifying.delete(symbol);
    listeners.get(symbol)?.forEach((notify) => notify());
  }, NOTIFY_MS);
}

/** The newest price published for `symbol`, if any. The same object until a new price arrives. */
export function getLivePrice(symbol: string): LivePrice | undefined {
  return latest.get(symbol);
}

/** Calls `notify` (soon) after the price of `symbol` changes. Returns the function that stops it. */
export function subscribeLivePrice(symbol: string, notify: () => void): () => void {
  let set = listeners.get(symbol);
  if (!set) listeners.set(symbol, (set = new Set()));
  set.add(notify);
  return () => {
    set.delete(notify);
    if (set.size === 0) listeners.delete(symbol);
  };
}
