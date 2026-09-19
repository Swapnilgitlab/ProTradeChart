import type { PriceAlert } from '../lib/ipc';

/** The rules of a price alert, with no I/O: when a price counts as having
 *  crossed a level, what an alert looks like after it fires, and how it reads
 *  to a person. The engine (`engine.ts`) supplies the prices. */

export type AlertCondition = 'crossing_up' | 'crossing_down' | 'crossing';
export type AlertMode = 'once' | 'every';
export type AlertStatus = 'active' | 'triggered' | 'paused';

/** An `every` alert that keeps crossing back and forth won't fire more often than this. */
export const COOLDOWN_MS = 60_000;

/** Whether a move from `previous` to `price` crossed `level` in the direction
 *  the condition asks for. Reaching the level counts as crossing it: 99 → 100
 *  crosses up through 100. Leaving a level you were sitting exactly on counts
 *  too (100 → 101 crosses up), but staying on it does not. */
export function crossed(condition: AlertCondition, level: number, previous: number, price: number): boolean {
  const up = (previous < level && price >= level) || (previous === level && price > level);
  const down = (previous > level && price <= level) || (previous === level && price < level);
  if (condition === 'crossing_up') return up;
  if (condition === 'crossing_down') return down;
  return up || down;
}

/** The direction a level implies from where the price is now: above it means
 *  the alert waits for the price to rise. At the level itself, either way. */
export function suggestCondition(level: number, current: number | null): AlertCondition {
  if (current === null) return 'crossing';
  if (level > current) return 'crossing_up';
  if (level < current) return 'crossing_down';
  return 'crossing';
}

export const CONDITION_LABELS: Record<AlertCondition, string> = {
  crossing_up: 'Crossing up',
  crossing_down: 'Crossing down',
  crossing: 'Crossing (either way)',
};

/** "Crosses above 250.00" — what the alert waits for. */
export function describeCondition(condition: AlertCondition, level: string): string {
  switch (condition) {
    case 'crossing_up':
      return `Crosses above ${level}`;
    case 'crossing_down':
      return `Crosses below ${level}`;
    case 'crossing':
      return `Crosses ${level}`;
  }
}

/** Whether the alert should fire on this sample. `previous` is the last price
 *  seen (or the alert's base price), or `null` when there is nothing to compare with. */
export function shouldFire(alert: PriceAlert, previous: number | null, price: number, now: number): boolean {
  if (alert.status !== 'active' || previous === null) return false;
  if (!crossed(alert.condition as AlertCondition, alert.price, previous, price)) return false;
  // A price wobbling around the level must not ring every poll.
  if (alert.mode === 'every' && alert.triggeredAt !== null && now - alert.triggeredAt < COOLDOWN_MS) return false;
  return true;
}

/** The alert as it stands after firing at `price`: a `once` alert is done, an
 *  `every` alert re-arms and measures its next crossing from here. */
export function afterFiring(alert: PriceAlert, price: number, now: number): PriceAlert {
  return {
    ...alert,
    status: alert.mode === 'once' ? 'triggered' : 'active',
    triggeredAt: now,
    triggerPrice: price,
    triggerCount: alert.triggerCount + 1,
    basePrice: price,
  };
}

export interface NewAlertInput {
  id: string;
  symbol: string;
  condition: AlertCondition;
  price: number;
  /** The price right now, if known — what the first crossing is measured from. */
  basePrice: number | null;
  message: string;
  mode: AlertMode;
  now: number;
}

export function newAlert(input: NewAlertInput): PriceAlert {
  return {
    id: input.id,
    symbol: input.symbol,
    condition: input.condition,
    price: input.price,
    basePrice: input.basePrice,
    message: input.message.trim(),
    mode: input.mode,
    status: 'active',
    createdAt: input.now,
    triggeredAt: null,
    triggerPrice: null,
    triggerCount: 0,
  };
}

/** What is wrong with a draft alert, in words for the person filling it in, or
 *  `null` if it is fine. Mirrors the backend's checks so the form can say it first. */
export function draftProblem(draft: { symbol: string; price: string; message: string }): string | null {
  if (!draft.symbol.trim()) return 'Choose a symbol for the alert.';
  const price = Number(draft.price.replace(/,/g, ''));
  if (draft.price.trim() === '' || !Number.isFinite(price) || price <= 0) return 'Enter a price above zero.';
  if (draft.message.length > 200) return 'The note is too long (200 characters at most).';
  return null;
}

/** Parses what was typed in a price field. `null` when it isn't a usable price. */
export function parsePrice(text: string): number | null {
  const value = Number(text.replace(/,/g, '').trim());
  return text.trim() !== '' && Number.isFinite(value) && value > 0 ? value : null;
}

/** The notification for a fired alert. `name` is the symbol as people read it
 *  (`RELIANCE`, not `zerodha:NSE:RELIANCE`). */
export function announcement(
  alert: PriceAlert,
  price: string,
  level: string,
  name: string,
): { title: string; body: string } {
  const direction =
    alert.condition === 'crossing_up' ? 'rose to' : alert.condition === 'crossing_down' ? 'fell to' : 'crossed';
  const note = alert.message ? ` — ${alert.message}` : '';
  return {
    title: `${name} alert`,
    body: `${name} ${direction} ${price} (alert level ${level})${note}`,
  };
}

export const isActive = (a: PriceAlert): boolean => a.status === 'active';

/** A price read off a chart (the exact value under the cursor) rounded to the
 *  precision worth showing: two decimals for ordinary prices, more for small
 *  ones where the extra digits matter. Trailing zeros are dropped. */
export function roundForDisplay(price: number): string {
  const decimals = price >= 100 ? 2 : price >= 1 ? 4 : 6;
  return String(Number(price.toFixed(decimals)));
}
