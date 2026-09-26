/** What a tab shows beside its symbol: the latest price and the day's change.
 *
 *  Two sources feed it. A poll (`fetchQuotes`) gives the price *and* the day's change, but only every few
 *  seconds; a chart that is streaming gives the price as it trades but knows nothing about yesterday's close.
 *  Put together, the price moves with the market and the change is measured from the poll's previous close.
 *  Pure, so the arithmetic and the rules about which one to trust are tested without a component. */

import type { PriceLike } from './listWindow';

/** A polled quote, stamped with when it was fetched. */
export interface TimedQuote extends PriceLike {
  at: number;
}

/** The last price a live stream delivered for a symbol, and when. */
export interface LivePrice {
  price: number;
  at: number;
}

/** A streamed price this old is not shown on its own: the stream may have stalled, and the poll (or nothing)
 *  is better than a price from a while ago. */
export const LIVE_TTL_MS = 120_000;

/** `prev` updated with a poll's results, each stamped `now`. A symbol that came back without a price keeps
 *  the quote it had, so one refused request never blanks a tab. Returns `prev` itself when no symbol got a
 *  price, so an empty poll re-renders nothing. */
export function withFreshQuotes(
  prev: ReadonlyMap<string, TimedQuote>,
  fresh: ReadonlyMap<string, PriceLike>,
  now: number,
): ReadonlyMap<string, TimedQuote> {
  let next: Map<string, TimedQuote> | null = null;
  for (const [symbol, quote] of fresh) {
    if (quote.price == null) continue;
    next ??= new Map(prev);
    next.set(symbol, { price: quote.price, changePercent: quote.changePercent, at: now });
  }
  return next ?? prev;
}

/** The price and change to show: the polled quote, moved on to the streamed price when that is newer.
 *
 *  The change is re-measured from the previous close the poll implies (`price / (1 + change%)`), so it follows
 *  the streamed price rather than sitting at the polled one. With no polled change there is nothing to measure
 *  from, and only the price is shown. */
export function withLivePrice(quote: TimedQuote | undefined, live: LivePrice | undefined, now: number): PriceLike {
  const polled: PriceLike = quote ? { price: quote.price, changePercent: quote.changePercent } : { price: null, changePercent: null };
  if (!live || !Number.isFinite(live.price)) return polled;
  if (!quote || quote.price == null) {
    return now - live.at > LIVE_TTL_MS ? polled : { price: live.price, changePercent: null };
  }
  if (live.at <= quote.at) return polled;

  const ratio = quote.changePercent == null ? null : 1 + quote.changePercent / 100;
  if (ratio === null || ratio <= 0) return { price: live.price, changePercent: null };
  const previousClose = quote.price / ratio;
  return { price: live.price, changePercent: ((live.price - previousClose) / previousClose) * 100 };
}
