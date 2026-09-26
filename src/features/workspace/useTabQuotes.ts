import { useEffect, useState } from 'react';
import { fetchQuotes, quoteRefreshMs } from '../../data/quotes';
import { withFreshQuotes, type TimedQuote } from '../../lib/tabQuote';

/** A window that regains focus re-polls, unless it did so this recently. */
const FOCUS_REFRESH_MIN_GAP_MS = 10_000;

/** Polled quotes for the symbols the tabs are showing, so each tab can wear a price and the day's change.
 *
 *  It only asks for those few symbols (one per tab — Dhan and Zerodha quote them in a single request),
 *  every 20 seconds at most, and not at all while the window is hidden. A streaming chart's own ticks are
 *  layered on top of this in the tab (see `lib/tabQuote.ts`); the poll is what gives the change from the
 *  previous close, and the price of a tab whose chart isn't streaming (a background tab that was never
 *  shown, a source that is polled). */
export function useTabQuotes(symbols: readonly string[]): ReadonlyMap<string, TimedQuote> {
  const [quotes, setQuotes] = useState<ReadonlyMap<string, TimedQuote>>(new Map());
  const key = [...new Set(symbols)].sort().join('|');

  useEffect(() => {
    if (!key) return;
    const wanted = key.split('|');
    let cancelled = false;
    let inFlight = false;
    let lastRun = 0;
    const run = async () => {
      if (cancelled || inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      lastRun = Date.now();
      try {
        const fresh = await fetchQuotes(wanted);
        if (!cancelled) setQuotes((prev) => withFreshQuotes(prev, fresh, Date.now()));
      } catch {
        // No price this time; the tab keeps the last one and the next poll tries again.
      } finally {
        inFlight = false;
      }
    };
    const onFocus = () => {
      if (Date.now() - lastRun >= FOCUS_REFRESH_MIN_GAP_MS) void run();
    };
    void run();
    const timer = window.setInterval(() => void run(), quoteRefreshMs(wanted));
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [key]);

  return quotes;
}
