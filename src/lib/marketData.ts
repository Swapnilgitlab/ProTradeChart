import type { MarketDataProgress, MarketDataStatus, MarketDataSummary } from './ipc';

const PHASE_LABELS: Record<MarketDataProgress['phase'], string> = {
  history: 'Loading history',
  prices: 'Updating latest prices',
  corrections: 'Catching up',
};

const count = (n: number) => n.toLocaleString('en-IN');

const day = (ms: number) =>
  new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

/** "Loading history · 340 of 2,113". */
export function describeProgress(p: MarketDataProgress | null): string {
  if (!p) return 'Starting';
  return p.total > 0 ? `${PHASE_LABELS[p.phase]} · ${count(p.done)} of ${count(p.total)}` : PHASE_LABELS[p.phase];
}

/** Whether the market is loaded: a load has finished since the app opened. Memory is empty after
 *  every launch, so there is no "done" that outlives the session. */
export const isLoaded = (s: MarketDataStatus) => s.lastUpdate !== null && s.holdings.series > 0;

/** When it was last updated: a time today, else a date. */
export function describeWhen(ms: number, now: number): string {
  return day(ms) === day(now) ? `today ${time(ms)}` : day(ms);
}

/** One line on what is loaded, or why nothing is. */
export function describeHoldings(s: MarketDataStatus, now: number): string {
  const { symbols, series, fromMs, toMs } = s.holdings;
  if (series === 0 || fromMs === null || toMs === null) {
    return s.keepLoaded ? 'Not loaded yet: it loads a couple of minutes after the app opens.' : 'Not loaded.';
  }
  const of = symbols > series ? ` of ${count(symbols)}` : '';
  const updated = s.lastUpdate !== null ? ` · updated ${describeWhen(s.lastUpdate, now)}` : '';
  return `${count(series)}${of} symbols loaded · ${day(fromMs)} to ${day(toMs)}${updated}`;
}

/** What a finished load did, for a one-line notice. */
export function describeSummary(s: MarketDataSummary): string {
  if (s.holiday) return 'No trading on the last session (a holiday): nothing to update.';
  const parts = [
    s.loaded > 0 && `${count(s.loaded)} loaded`,
    s.newListings > 0 && s.newListings < s.listed && `${count(s.newListings)} new listing${s.newListings === 1 ? '' : 's'}`,
    s.updated > 0 && `${count(s.updated)} updated`,
    s.reloaded > 0 && `${count(s.reloaded)} read again`,
    s.failed > 0 && `${count(s.failed)} couldn't be read`,
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(', ')}.` : 'Already up to date.';
}
