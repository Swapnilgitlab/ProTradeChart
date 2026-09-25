/** Helpers for long lists (a 1,000-symbol watchlist): which rows to render, and
 *  which symbols to fetch prices for, so that neither scales with the list. */

/** A slice of a list's rows, `end` exclusive. */
export interface RowWindow {
  start: number;
  end: number;
}

/** The rows on screen in a list of `count` rows of `rowHeight` px, plus `overscan`
 *  rows either side so a short scroll never shows a blank before React catches up. */
export function rowWindow(scrollTop: number, viewportHeight: number, rowHeight: number, count: number, overscan: number): RowWindow {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const onScreen = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;
  return {
    start: Math.min(count, Math.max(0, first - overscan)),
    end: Math.min(count, first + onScreen + overscan),
  };
}

/** A list this short is quoted whole on every refresh: it costs a few requests at most. */
export const SMALL_LIST = 60;

/** The next `size` items after `cursor`, wrapping at the end, and where to continue. */
export function rollingSlice<T>(items: readonly T[], cursor: number, size: number): { slice: T[]; next: number } {
  if (items.length === 0 || size <= 0) return { slice: [], next: 0 };
  if (size >= items.length) return { slice: [...items], next: 0 };
  const from = ((cursor % items.length) + items.length) % items.length;
  const slice = items.slice(from, from + size);
  if (slice.length < size) slice.push(...items.slice(0, size - slice.length));
  return { slice, next: (from + size) % items.length };
}

/** Which symbols one watchlist refresh should quote.
 *
 *  A short list is quoted whole. A long one quotes only the rows on screen —
 *  quoting all 1,000 every refresh took the app's whole request budget and left
 *  charts starved — except while it's sorted by price, which needs a price for
 *  every row: then each refresh also walks on through the rest, a chunk at a time. */
export function quoteTargets(
  all: readonly string[],
  visible: readonly string[],
  sortNeedsAll: boolean,
  cursor: number,
  chunk: number,
): { symbols: string[]; next: number } {
  if (all.length <= SMALL_LIST) return { symbols: [...all], next: cursor };
  if (!sortNeedsAll) return { symbols: [...visible], next: cursor };
  const { slice, next } = rollingSlice(all, cursor, chunk);
  return { symbols: [...new Set([...visible, ...slice])], next };
}

export interface PriceLike {
  price: number | null;
  changePercent: number | null;
}

/** `prev` updated with `fresh`. A symbol that came back without a price keeps
 *  the one it had, so a refused request never blanks a row. Returns `prev`
 *  itself when nothing changed, so an unchanged refresh re-renders nothing. */
export function mergeQuotes<Q extends PriceLike>(prev: Map<string, Q>, fresh: Map<string, Q>): Map<string, Q> {
  let next: Map<string, Q> | null = null;
  for (const [symbol, quote] of fresh) {
    const old = prev.get(symbol);
    if (quote.price == null && old) continue;
    if (old && old.price === quote.price && old.changePercent === quote.changePercent) continue;
    next ??= new Map(prev);
    next.set(symbol, quote);
  }
  return next ?? prev;
}
