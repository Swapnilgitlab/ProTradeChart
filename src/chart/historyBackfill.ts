import type { Vela } from '@luxalgo/vela';

/** Loads older candles as the user scrolls or zooms back through history.
 *
 *  Vela loads a chart to a fixed *depth* (`market.bars`, 500 by default — about
 *  two years of daily candles) and never fetches more by itself: a scroll past
 *  the oldest bar just shows empty space. Raising the depth makes Vela fetch the
 *  extra bars and prepend them without moving the view, so this watches the
 *  viewport and raises it when the left edge nears the oldest loaded bar. Each
 *  step doubles the depth, and it repeats until the view is covered, the source
 *  has nothing older (`genesis`), or it keeps failing. */

/** Bars added per step, at least — and the depth doubles beyond that. */
const MIN_GROWTH = 500;
/** A ceiling so a runaway view can never ask for an absurd amount of data. */
const MAX_DEPTH = 50_000;
/** Load more once the left edge is within this fraction of a screen of the oldest bar. */
const EDGE_FRACTION = 0.5;
/** After a failed load, wait this long before trying again... */
const RETRY_AFTER_MS = 30_000;
/** ...and give up after this many failures in a row. */
const MAX_FAILURES = 3;
/** A load that never reports back is presumed lost after this long. */
const BUSY_TIMEOUT_MS = 60_000;

export interface VisibleRange {
  from: number;
  to: number;
}

export interface HistoryResult {
  reason: 'depth' | 'genesis' | 'aborted';
  oldestTime: number;
  barsLoaded: number;
}

export interface BackfillHooks {
  /** Asks the chart to load up to `bars` bars in total. */
  request: (bars: number) => void;
  /** Identifies what the chart is showing (symbol and timeframe). */
  marketKey: () => string;
  /** The depth the chart has been told to load, if known. */
  requestedDepth?: () => number | undefined;
  now?: () => number;
}

/** Whether the visible range reaches (or nearly reaches) the oldest loaded bar. */
export function needsOlderBars(view: VisibleRange, oldest: number): boolean {
  const width = Math.max(view.to - view.from, 1);
  return view.from - oldest <= width * EDGE_FRACTION;
}

/** The depth to ask for next: double what is loaded, by at least `MIN_GROWTH`. */
export function nextDepth(loaded: number): number {
  return Math.min(MAX_DEPTH, loaded + Math.max(MIN_GROWTH, loaded));
}

export class HistoryBackfill {
  private view: VisibleRange | undefined;
  private oldest: number | undefined;
  private loaded = 0;
  /** The market the `oldest`/`loaded` figures describe. */
  private loadedKey: string | undefined;
  private busySince: number | undefined;
  private exhausted = false;
  private failures = 0;
  private retryAt = 0;

  constructor(private readonly hooks: BackfillHooks) {}

  private now(): number {
    return (this.hooks.now ?? Date.now)();
  }

  onViewport(view: VisibleRange): void {
    this.view = view;
    this.consider();
  }

  /** A history load has finished — the first one, a market switch, or one of ours. */
  onHistory(result: HistoryResult): void {
    this.busySince = undefined;
    this.oldest = result.oldestTime;
    this.loaded = result.barsLoaded;
    this.loadedKey = this.hooks.marketKey();
    this.exhausted = result.reason === 'genesis';
    if (result.reason === 'aborted') {
      this.failures += 1;
      this.retryAt = this.now() + RETRY_AFTER_MS;
    } else {
      this.failures = 0;
    }
    // The view may still reach past what is loaded (zoomed far out): carry on.
    this.consider();
  }

  /** The request itself could not be made. */
  onRequestFailed(): void {
    this.busySince = undefined;
    this.failures += 1;
    this.retryAt = this.now() + RETRY_AFTER_MS;
  }

  private consider(): void {
    const { view, oldest } = this;
    if (!view || oldest === undefined) return; // nothing has loaded yet
    if (this.exhausted || this.failures >= MAX_FAILURES) return;
    if (this.loaded >= MAX_DEPTH || this.now() < this.retryAt) return;
    // A market switch is still loading: the figures above describe the old one.
    if (this.hooks.marketKey() !== this.loadedKey) return;
    if (this.busySince !== undefined) {
      if (this.now() - this.busySince < BUSY_TIMEOUT_MS) return;
      this.busySince = undefined; // the last request never reported back
    }
    if (!needsOlderBars(view, oldest)) return;

    const base = Math.max(this.loaded, this.hooks.requestedDepth?.() ?? 0);
    this.busySince = this.now();
    this.hooks.request(nextDepth(base));
  }
}

/** Starts backfilling older history for one chart; returns a function that stops it. */
export function watchHistory(chart: Vela): () => void {
  const read = <T>(get: () => T): T | undefined => {
    try {
      return get();
    } catch {
      return undefined; // the chart has been destroyed
    }
  };
  const backfill = new HistoryBackfill({
    marketKey: () => read(() => `${chart.market.symbol}|${chart.market.timeframe}`) ?? '',
    requestedDepth: () => read(() => chart.market.bars),
    request: (bars) => {
      chart.setMarket({ bars }).catch(() => backfill.onRequestFailed());
    },
  });
  const stops = [
    chart.on('viewport:changed', (view) => backfill.onViewport(view)),
    chart.on('history:complete', (result) => backfill.onHistory(result)),
  ];
  return () => stops.forEach((stop) => stop());
}
