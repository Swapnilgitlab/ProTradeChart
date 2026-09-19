import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { HistoryBackfill, needsOlderBars, nextDepth, type HistoryResult } from './historyBackfill';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
/** A view `days` wide whose left edge is `fromDay` days after the epoch of the tests. */
const view = (fromDay: number, days = 100) => ({ from: T0 + fromDay * DAY, to: T0 + (fromDay + days) * DAY });
const done = (oldestDay: number, barsLoaded: number, reason: HistoryResult['reason'] = 'depth'): HistoryResult => ({
  reason,
  oldestTime: T0 + oldestDay * DAY,
  barsLoaded,
});

describe('needsOlderBars', () => {
  it('is false while plenty of loaded history lies to the left of the view', () => {
    expect(needsOlderBars(view(300), T0)).toBe(false);
  });

  it('is true once the left edge is within half a screen of the oldest bar', () => {
    expect(needsOlderBars(view(50, 100), T0)).toBe(true); // exactly half a screen away
    expect(needsOlderBars(view(51, 100), T0)).toBe(false);
  });

  it('is true when the view reaches past the oldest bar', () => {
    expect(needsOlderBars(view(-40), T0)).toBe(true);
  });
});

describe('nextDepth', () => {
  it('doubles what is loaded, by at least 500', () => {
    expect(nextDepth(500)).toBe(1000);
    expect(nextDepth(1000)).toBe(2000);
    expect(nextDepth(100)).toBe(600);
  });

  it('never asks for more than the ceiling', () => {
    expect(nextDepth(40_000)).toBe(50_000);
  });
});

describe('HistoryBackfill', () => {
  let request: Mock<(bars: number) => void>;
  let market: string;
  let clock: number;
  let requested: number | undefined;
  let backfill: HistoryBackfill;

  beforeEach(() => {
    request = vi.fn<(bars: number) => void>();
    market = 'yahoo:AAPL|D';
    clock = 1_000_000;
    requested = undefined;
    backfill = new HistoryBackfill({
      request,
      marketKey: () => market,
      requestedDepth: () => requested,
      now: () => clock,
    });
  });

  it('does nothing before the first load has reported where the history starts', () => {
    backfill.onViewport(view(-100));
    expect(request).not.toHaveBeenCalled();
  });

  it('does nothing while the user is looking at the middle of the loaded data', () => {
    backfill.onHistory(done(0, 500));
    backfill.onViewport(view(350));
    expect(request).not.toHaveBeenCalled();
  });

  it('loads more when the user scrolls near the oldest bar', () => {
    backfill.onHistory(done(0, 500));
    backfill.onViewport(view(30));
    expect(request).toHaveBeenCalledWith(1000);
  });

  it('asks only once while a load is in flight, however many viewport events arrive', () => {
    backfill.onHistory(done(0, 500));
    for (let day = 30; day > -20; day -= 5) backfill.onViewport(view(day));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps going, doubling each time, while the view still reaches past the loaded data', () => {
    backfill.onHistory(done(0, 500));
    backfill.onViewport(view(-3000)); // zoomed far out
    expect(request).toHaveBeenLastCalledWith(1000);

    backfill.onHistory(done(-700, 1000)); // arrived, but the view still reaches further back
    expect(request).toHaveBeenLastCalledWith(2000);

    backfill.onHistory(done(-1500, 2000));
    expect(request).toHaveBeenLastCalledWith(4000);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('stops asking once the view is covered', () => {
    backfill.onHistory(done(0, 500));
    backfill.onViewport(view(20));
    backfill.onHistory(done(-700, 1000));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('stops for good when the source has nothing older', () => {
    backfill.onHistory(done(0, 500));
    backfill.onViewport(view(-10));
    backfill.onHistory(done(-40, 540, 'genesis'));
    backfill.onViewport(view(-60));
    backfill.onViewport(view(-90));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('starts again for a different symbol or timeframe', () => {
    backfill.onHistory(done(0, 500, 'genesis'));
    backfill.onViewport(view(-10));
    expect(request).not.toHaveBeenCalled();

    market = 'yahoo:MSFT|D';
    backfill.onHistory(done(0, 500)); // the new market's own load
    backfill.onViewport(view(-10));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('ignores viewport movement while a symbol switch is still loading', () => {
    backfill.onHistory(done(0, 500));
    market = 'yahoo:MSFT|D'; // switched, but its history has not landed yet
    backfill.onViewport(view(-10));
    expect(request).not.toHaveBeenCalled();
  });

  it('waits after a failed load, then tries again', () => {
    backfill.onHistory(done(0, 500));
    backfill.onViewport(view(-10));
    expect(request).toHaveBeenCalledTimes(1);

    backfill.onHistory(done(0, 500, 'aborted'));
    backfill.onViewport(view(-20));
    expect(request).toHaveBeenCalledTimes(1); // too soon

    clock += 30_001;
    backfill.onViewport(view(-30));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('gives up after three failures in a row, and a success clears the count', () => {
    backfill.onHistory(done(0, 500));
    backfill.onViewport(view(-10));
    for (let i = 0; i < 3; i++) {
      clock += 31_000;
      backfill.onHistory(done(0, 500, 'aborted'));
      clock += 31_000;
      backfill.onViewport(view(-10 - i));
    }
    expect(request).toHaveBeenCalledTimes(3); // the original plus two retries; the third failure ended it

    clock += 31_000;
    backfill.onViewport(view(-50));
    expect(request).toHaveBeenCalledTimes(3);

    // A different market loading fine starts from scratch.
    market = 'yahoo:MSFT|D';
    backfill.onHistory(done(0, 500));
    backfill.onViewport(view(-10));
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('treats a request that could not even be made like a failed load', () => {
    backfill.onHistory(done(0, 500));
    backfill.onViewport(view(-10));
    backfill.onRequestFailed();
    backfill.onViewport(view(-20));
    expect(request).toHaveBeenCalledTimes(1);
    clock += 30_001;
    backfill.onViewport(view(-30));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('recovers if a load never reports back', () => {
    backfill.onHistory(done(0, 500));
    backfill.onViewport(view(-10));
    clock += 30_000;
    backfill.onViewport(view(-20));
    expect(request).toHaveBeenCalledTimes(1);
    clock += 31_000; // a minute since the request went out
    backfill.onViewport(view(-30));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('builds on the depth the chart was already told to load, if that is larger', () => {
    requested = 3000;
    backfill.onHistory(done(0, 500));
    backfill.onViewport(view(-10));
    expect(request).toHaveBeenCalledWith(6000);
  });

  it('stops at the ceiling', () => {
    backfill.onHistory(done(0, 50_000));
    backfill.onViewport(view(-10));
    expect(request).not.toHaveBeenCalled();
  });
});
