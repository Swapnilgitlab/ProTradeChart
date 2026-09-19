import { describe, expect, it } from 'vitest';
import { formatBars, formatMoney, formatPct, formatQty, formatRatio, formatSignedMoney, formatWhen, pnlClass } from './format';

describe('pine formatting', () => {
  it('formats money with separators, a real minus sign and an optional currency', () => {
    expect(formatMoney(1234.5)).toBe('1,234.50');
    expect(formatMoney(-98)).toBe('−98.00');
    expect(formatMoney(10, 'USD')).toBe('10.00 USD');
    expect(formatMoney(10, 'NONE')).toBe('10.00');
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(Number.NaN)).toBe('—');
  });

  it('signs gains only when asked', () => {
    expect(formatSignedMoney(5)).toBe('+5.00');
    expect(formatSignedMoney(-5)).toBe('−5.00');
    expect(formatSignedMoney(0)).toBe('0.00');
    expect(formatPct(12.345)).toBe('12.35%');
    expect(formatPct(12.345, true)).toBe('+12.35%');
    expect(formatPct(-1, true)).toBe('−1.00%');
  });

  it('trims position sizes but keeps small ones readable', () => {
    expect(formatQty(111.509203)).toBe('111.51');
    expect(formatQty(10)).toBe('10');
    expect(formatQty(0.4460354657)).toBe('0.446035');
    expect(formatQty(-5.5)).toBe('-5.5');
  });

  it('handles ratios, bar counts and missing values', () => {
    expect(formatRatio(1.6666)).toBe('1.67');
    expect(formatRatio(null)).toBe('—');
    expect(formatBars(2.5)).toBe('3');
    expect(formatBars(undefined)).toBe('—');
  });

  it('shows the date alone for a midnight bar and the time for an intraday one', () => {
    expect(formatWhen(new Date(2024, 2, 5).getTime())).toBe('2024-03-05');
    expect(formatWhen(new Date(2024, 2, 5, 14, 30).getTime())).toBe('2024-03-05 14:30');
    expect(formatWhen(null)).toBe('—');
  });

  it('picks the P&L colour class', () => {
    expect(pnlClass(1)).toBe('pos');
    expect(pnlClass(-1)).toBe('neg');
    expect(pnlClass(0)).toBe('');
    expect(pnlClass(null)).toBe('');
  });
});
