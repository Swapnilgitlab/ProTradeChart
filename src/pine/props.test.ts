import { describe, expect, it } from 'vitest';
import { currencyProp, effectiveProps, numberProp } from './props';

describe('effectiveProps', () => {
  it('layers the user overrides over the declared defaults', () => {
    const props = effectiveProps({
      props: [
        { key: 'initial_capital', defval: 10000 },
        { key: 'commission_type', defval: 'percent' },
        { key: 'commission_value', defval: 0 },
      ],
      propValues: () => ({ commission_value: 0.1, extra: true }),
    });
    expect(props).toEqual({ initial_capital: 10000, commission_type: 'percent', commission_value: 0.1, extra: true });
  });
});

describe('prop readers', () => {
  it('falls back for missing or non-numeric values', () => {
    expect(numberProp({ a: 5 }, 'a', 1)).toBe(5);
    expect(numberProp({ a: '5' }, 'a', 1)).toBe(1);
    expect(numberProp({ a: Number.NaN }, 'a', 1)).toBe(1);
    expect(numberProp({}, 'a', 1)).toBe(1);
  });

  it('treats NONE as no currency', () => {
    expect(currencyProp({ currency: 'USD' })).toBe('USD');
    expect(currencyProp({ currency: 'NONE' })).toBeUndefined();
    expect(currencyProp({})).toBeUndefined();
  });
});
