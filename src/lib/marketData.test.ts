import { describe, expect, it } from 'vitest';
import type { MarketDataStatus, MarketDataSummary } from './ipc';
import { describeHoldings, describeProgress, describeSummary, describeWhen, isLoaded } from './marketData';

/** 2 October 2026, 18:00 IST. */
const NOW = Date.UTC(2026, 9, 2, 12, 30);

const status = (over: Partial<MarketDataStatus> = {}): MarketDataStatus => ({
  keepLoaded: true,
  running: null,
  lastUpdate: NOW - 3_600_000,
  lastFailure: null,
  lastError: null,
  holdings: { symbols: 2113, series: 2113, fromMs: Date.UTC(2021, 9, 1, 18, 30), toMs: NOW },
  ...over,
});

const nothing = { symbols: 2113, series: 0, fromMs: null, toMs: null };

const summary = (over: Partial<MarketDataSummary> = {}): MarketDataSummary => ({
  listed: 2113,
  newListings: 0,
  loaded: 0,
  updated: 0,
  reloaded: 0,
  failed: 0,
  holiday: false,
  ...over,
});

describe('market data status', () => {
  it('names the phase and how far it has got', () => {
    expect(describeProgress({ phase: 'history', done: 340, total: 2113 })).toBe('Loading history · 340 of 2,113');
    expect(describeProgress({ phase: 'prices', done: 0, total: 0 })).toBe('Updating latest prices');
    expect(describeProgress(null)).toBe('Starting');
  });

  it('is loaded only once a load has finished this session', () => {
    expect(isLoaded(status())).toBe(true);
    expect(isLoaded(status({ lastUpdate: null }))).toBe(false);
    expect(isLoaded(status({ holdings: nothing }))).toBe(false);
  });

  it('says what is loaded, and from when to when', () => {
    expect(describeHoldings(status({ keepLoaded: false, holdings: nothing }), NOW)).toBe('Not loaded.');
    expect(describeHoldings(status({ holdings: nothing, lastUpdate: null }), NOW)).toContain('a couple of minutes after the app opens');
    const text = describeHoldings(status(), NOW);
    expect(text).toContain('2,113 symbols loaded');
    expect(text).toContain('2021');
    expect(text).toContain('updated today');
    expect(describeHoldings(status({ holdings: { ...status().holdings, series: 2000 } }), NOW)).toContain('2,000 of 2,113 symbols');
  });

  it('gives a time for today and a date for anything older', () => {
    expect(describeWhen(NOW - 60_000, NOW)).toMatch(/^today /);
    expect(describeWhen(NOW - 3 * 86_400_000, NOW)).toContain('2026');
  });

  it('summarises a load in a line', () => {
    expect(describeSummary(summary({ updated: 2110, reloaded: 2, failed: 1 }))).toBe(
      "2,110 updated, 2 read again, 1 couldn't be read.",
    );
    expect(describeSummary(summary({ loaded: 1, newListings: 1, updated: 2112 }))).toBe('1 loaded, 1 new listing, 2,112 updated.');
    // The first load lists everything as new; that isn't news.
    expect(describeSummary(summary({ loaded: 2113, newListings: 2113 }))).toBe('2,113 loaded.');
    expect(describeSummary(summary())).toBe('Already up to date.');
    expect(describeSummary(summary({ holiday: true }))).toContain('holiday');
  });
});
