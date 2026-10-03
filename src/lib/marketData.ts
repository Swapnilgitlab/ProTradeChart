import type { MarketDataProgress, MarketDataStatus, MarketDataSummary } from './ipc';

const PHASE_LABELS: Record<MarketDataProgress['phase'], string> = {
  history: 'Downloading history',
  prices: 'Updating latest prices',
  corrections: 'Catching up',
};

const count = (n: number) => n.toLocaleString('en-IN');

const day = (ms: number) =>
  new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

/** "Downloading history · 340 of 2,113". */
export function describeProgress(p: MarketDataProgress | null): string {
  if (!p) return 'Starting';
  return p.total > 0 ? `${PHASE_LABELS[p.phase]} · ${count(p.done)} of ${count(p.total)}` : PHASE_LABELS[p.phase];
}

/** Whether the history has been downloaded: a run has finished at least once. */
export const isDownloaded = (s: MarketDataStatus) => s.provider !== null && s.lastUpdate !== null;

/** When it was last updated: a time today, else a date. */
export function describeWhen(ms: number, now: number): string {
  return day(ms) === day(now) ? `today ${time(ms)}` : day(ms);
}

/** One line on what the store holds, or what's needed before it holds anything. */
export function describeHoldings(s: MarketDataStatus, now: number): string {
  if (!s.provider) return 'Not downloaded yet.';
  const { series, fromMs, toMs } = s.holdings;
  if (series === 0 || fromMs === null || toMs === null) return 'Nothing downloaded yet.';
  const updated = s.lastUpdate !== null ? ` · updated ${describeWhen(s.lastUpdate, now)}` : '';
  return `${count(series)} symbols · ${day(fromMs)} to ${day(toMs)}${updated}`;
}

/** What a finished run did, for a one-line notice. */
export function describeSummary(s: MarketDataSummary): string {
  if (s.holiday) return 'No trading on the last session (a holiday): nothing to update.';
  const parts = [
    s.downloaded > 0 && `${count(s.downloaded)} downloaded`,
    s.newListings > 0 && s.newListings < s.listed && `${count(s.newListings)} new listing${s.newListings === 1 ? '' : 's'}`,
    s.updated > 0 && `${count(s.updated)} updated`,
    s.refetched > 0 && `${count(s.refetched)} re-read after a split or bonus`,
    s.failed > 0 && `${count(s.failed)} couldn't be read`,
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(', ')}.` : 'Already up to date.';
}
