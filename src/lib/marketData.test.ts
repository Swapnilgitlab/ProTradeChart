import { describe, expect, it } from 'vitest';
import type { MarketDataStatus, MarketDataSummary } from './ipc';
import { describeHoldings, describeProgress, describeSummary, describeWhen, isDownloaded } from './marketData';

/** 2 October 2026, 18:00 IST. */
const NOW = Date.UTC(2026, 9, 2, 12, 30);

const status = (over: Partial<MarketDataStatus> = {}): MarketDataStatus => ({
  provider: 'zerodha',
  autoUpdate: true,
  running: null,
  lastUpdate: NOW - 3_600_000,
  lastFailure: null,
  lastError: null,
  holdings: { symbols: 2113, series: 2113, fromMs: Date.UTC(2021, 9, 1, 18, 30), toMs: NOW },
  ...over,
});

const summary = (over: Partial<MarketDataSummary> = {}): MarketDataSummary => ({
  listed: 2113,
  newListings: 0,
  downloaded: 0,
  updated: 0,
  refetched: 0,
  failed: 0,
  holiday: false,
  ...over,
});

describe('market data status', () => {
  it('names the phase and how far it has got', () => {
    expect(describeProgress({ phase: 'history', done: 340, total: 2113 })).toBe('Downloading history · 340 of 2,113');
    expect(describeProgress({ phase: 'prices', done: 0, total: 0 })).toBe('Updating latest prices');
    expect(describeProgress(null)).toBe('Starting');
  });

  it('is downloaded only once a run has finished', () => {
    expect(isDownloaded(status())).toBe(true);
    expect(isDownloaded(status({ lastUpdate: null }))).toBe(false);
    expect(isDownloaded(status({ provider: null, lastUpdate: null }))).toBe(false);
  });

  it('says what the store holds, and from when to when', () => {
    expect(describeHoldings(status({ provider: null }), NOW)).toBe('Not downloaded yet.');
    expect(describeHoldings(status({ holdings: { symbols: 0, series: 0, fromMs: null, toMs: null } }), NOW)).toBe(
      'Nothing downloaded yet.',
    );
    const text = describeHoldings(status(), NOW);
    expect(text).toContain('2,113 symbols');
    expect(text).toContain('2021');
    expect(text).toContain('updated today');
  });

  it('gives a time for today and a date for anything older', () => {
    expect(describeWhen(NOW - 60_000, NOW)).toMatch(/^today /);
    expect(describeWhen(NOW - 3 * 86_400_000, NOW)).toContain('2026');
  });

  it('summarises a run in a line', () => {
    expect(describeSummary(summary({ updated: 2110, refetched: 2, failed: 1 }))).toBe(
      "2,110 updated, 2 re-read after a split or bonus, 1 couldn't be read.",
    );
    expect(describeSummary(summary({ downloaded: 1, newListings: 1, updated: 2112 }))).toBe(
      '1 downloaded, 1 new listing, 2,112 updated.',
    );
    // The first run lists everything as new; that isn't news.
    expect(describeSummary(summary({ downloaded: 2113, newListings: 2113 }))).toBe('2,113 downloaded.');
    expect(describeSummary(summary())).toBe('Already up to date.');
    expect(describeSummary(summary({ holiday: true }))).toContain('holiday');
  });
});
