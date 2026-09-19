import { describe, expect, it } from 'vitest';
import { describeKiteTokenExpiry, describeTokenExpiry, formatPercent, formatPrice, formatSpan } from './format';

describe('formatPrice', () => {
  it('uses two decimals for large prices', () => {
    expect(formatPrice(189.95)).toBe('189.95');
    expect(formatPrice(5432.1)).toMatch(/5.?432\.10/); // thousands separator is locale-dependent
  });

  it('keeps the extra precision FX and small prices carry', () => {
    expect(formatPrice(1.0843)).toBe('1.0843');
    expect(formatPrice(35.5)).toBe('35.50');
    expect(formatPrice(0.000123)).toBe('0.000123');
    expect(formatPrice(0.5)).toBe('0.50');
  });

  it('renders a dash when there is no usable quote', () => {
    expect(formatPrice(null)).toBe('—');
    expect(formatPrice(undefined)).toBe('—');
    expect(formatPrice(Number.NaN)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('signs and rounds', () => {
    expect(formatPercent(1.256)).toBe('+1.26%');
    expect(formatPercent(-0.4)).toBe('-0.40%');
    expect(formatPercent(0)).toBe('+0.00%');
    expect(formatPercent(null)).toBe('—');
  });
});

describe('formatSpan', () => {
  it('reads as days, hours or minutes', () => {
    expect(formatSpan(45 * 60)).toBe('45m');
    expect(formatSpan(5 * 3600 + 12 * 60)).toBe('5h 12m');
    expect(formatSpan(2 * 86_400 + 3 * 3600)).toBe('2d 3h');
    expect(formatSpan(-3600)).toBe('1h 0m');
  });
});

describe('describeTokenExpiry', () => {
  const now = 1_800_000_000_000;
  it('says how long a token has left, and warns when it is nearly out', () => {
    const fine = describeTokenExpiry(now / 1000 + 20 * 3600, now);
    expect(fine).toMatchObject({ text: 'Valid for another 20h 0m.', expired: false, soon: false });
    expect(describeTokenExpiry(now / 1000 + 3600, now).soon).toBe(true);
  });

  it('reports an expired token and an unreadable one', () => {
    expect(describeTokenExpiry(now / 1000 - 7200, now)).toMatchObject({ text: 'Expired 2h 0m ago.', expired: true });
    expect(describeTokenExpiry(null, now).expired).toBe(false);
  });
});

describe('describeKiteTokenExpiry', () => {
  const now = 1_800_000_000_000;

  it('says how long the token should last, and warns when the morning reset is near', () => {
    const fine = describeKiteTokenExpiry(now / 1000 + 9 * 3600, now);
    expect(fine).toMatchObject({ text: 'Should work for another 9h 0m (Kite tokens reset around 6 AM).', expired: false, soon: false });
    expect(describeKiteTokenExpiry(now / 1000 + 1800, now).soon).toBe(true);
  });

  it('asks for a new login once it has expired', () => {
    expect(describeKiteTokenExpiry(now / 1000 - 3 * 3600, now)).toMatchObject({
      text: 'Expired 3h 0m ago — log in again.',
      expired: true,
    });
  });

  it('is honest when it does not know when the token was issued', () => {
    const unknown = describeKiteTokenExpiry(null, now);
    expect(unknown.expired).toBe(false);
    expect(unknown.text).toContain("isn't known");
  });
});
