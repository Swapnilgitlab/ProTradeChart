import { describe, expect, it } from 'vitest';
import type { SavedPricesStatus } from './ipc';
import { SAVING_NOTICE, describeSaved, describeSuppliers, formatBytes, suppliedBy } from './savedPrices';

const status = (over: Partial<SavedPricesStatus> = {}): SavedPricesStatus => ({
  on: true,
  problem: null,
  bytes: 0,
  open: true,
  series: 0,
  dailySeries: 0,
  bars: 0,
  fromMs: null,
  toMs: null,
  supplied: [
    { broker: 'zerodha', label: 'Zerodha', series: 0 },
    { broker: 'fyers', label: 'FYERS', series: 0 },
  ],
  ...over,
});

describe('saved prices', () => {
  it('sizes files in the unit that reads best', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(230 * 1024 * 1024)).toBe('230 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });

  it('describes the file in use, an empty one, and one not in use', () => {
    const full = status({
      bytes: 150 * 1024 * 1024,
      series: 2120,
      dailySeries: 2113,
      bars: 2_600_000,
      fromMs: Date.UTC(2021, 9, 1, 18, 30),
      toMs: Date.UTC(2026, 9, 28, 18, 30),
    });
    expect(describeSaved(full)).toBe('2,120 series, 2,113 daily · 150 MB · daily from 2 Oct 2021 to 29 Oct 2026');
    expect(describeSaved(status())).toMatch(/nothing saved yet/i);
    expect(describeSaved(status({ open: false, series: null, bytes: 2048 }))).toBe('2.0 KB saved, not in use');
    expect(describeSaved(status({ open: false, series: null }))).toBe('Nothing saved.');
  });

  it('names the brokers that supplied them only when there is more than one', () => {
    expect(describeSuppliers(status())).toBeNull();
    const one = status({ supplied: [{ broker: 'zerodha', label: 'Zerodha', series: 5 }] });
    expect(describeSuppliers(one)).toBeNull();
    const both = status({
      supplied: [
        { broker: 'zerodha', label: 'Zerodha', series: 2100 },
        { broker: 'fyers', label: 'FYERS', series: 40 },
      ],
    });
    expect(describeSuppliers(both)).toBe('Supplied by Zerodha (2,100) and FYERS (40)');
    expect(suppliedBy(both, 'fyers')).toBe(40);
    expect(suppliedBy(null, 'fyers')).toBe(0);
  });

  it('names both brokers’ terms and who is responsible before anything is saved', () => {
    expect(SAVING_NOTICE).toContain('build databases');
    expect(SAVING_NOTICE).toContain('permanent or temporary copies');
    expect(SAVING_NOTICE).toContain('your responsibility');
    expect(SAVING_NOTICE).toContain('deletes the file');
  });
});
