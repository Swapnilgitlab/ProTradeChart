import { describe, expect, it } from 'vitest';
import { parseTimeframe } from '../../lib/timeframes';
import { DAY_MS, isBackfillRequest, lookbackMs } from './common';

const tf = (s: string) => parseTimeframe(s)!;

describe('isBackfillRequest', () => {
  it('recognises "N bars ending at `to`" — what Vela asks for while the user scrolls back', () => {
    expect(isBackfillRequest({ to: 1_700_000_000_000 })).toBe(true);
  });

  it('is false for the newest data, and for an explicit window', () => {
    expect(isBackfillRequest({})).toBe(false);
    expect(isBackfillRequest({ from: 1, to: 2 })).toBe(false);
    expect(isBackfillRequest({ from: 1 })).toBe(false);
  });
});

describe('lookbackMs', () => {
  it('covers the requested bars with room to spare for closed days', () => {
    // 500 daily bars are ~700 calendar days.
    expect(lookbackMs(tf('D'), 500)).toBeGreaterThan(700 * DAY_MS);
    // A weekly bar covers a week.
    expect(lookbackMs(tf('W'), 100)).toBe(100 * 7 * DAY_MS);
  });

  it('never looks back less than the longest closure, so a chunk cannot land wholly in a weekend', () => {
    expect(lookbackMs(tf('1'), 501)).toBeGreaterThanOrEqual(7 * DAY_MS);
    expect(lookbackMs(tf('5'), 3)).toBeGreaterThanOrEqual(7 * DAY_MS);
    expect(lookbackMs(tf('D'), 2)).toBeGreaterThanOrEqual(10 * DAY_MS);
  });

  it('leaves large requests alone', () => {
    expect(lookbackMs(tf('60'), 5000)).toBe(5000 * 60 * 60_000 * 6);
  });
});
