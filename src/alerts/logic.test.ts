import { describe, expect, it } from 'vitest';
import type { PriceAlert } from '../lib/ipc';
import {
  afterFiring,
  announcement,
  COOLDOWN_MS,
  crossed,
  describeCondition,
  draftProblem,
  newAlert,
  parsePrice,
  roundForDisplay,
  shouldFire,
  suggestCondition,
} from './logic';

const alert = (over: Partial<PriceAlert> = {}): PriceAlert => ({
  id: 'a1',
  symbol: 'binance:BTCUSDT',
  condition: 'crossing_up',
  price: 100,
  basePrice: 90,
  message: '',
  mode: 'once',
  status: 'active',
  createdAt: 1,
  triggeredAt: null,
  triggerPrice: null,
  triggerCount: 0,
  ...over,
});

describe('crossed', () => {
  it('sees a price rise through the level', () => {
    expect(crossed('crossing_up', 100, 99, 101)).toBe(true);
    expect(crossed('crossing_down', 100, 99, 101)).toBe(false);
    expect(crossed('crossing', 100, 99, 101)).toBe(true);
  });

  it('sees a price fall through the level', () => {
    expect(crossed('crossing_down', 100, 101, 99)).toBe(true);
    expect(crossed('crossing_up', 100, 101, 99)).toBe(false);
    expect(crossed('crossing', 100, 101, 99)).toBe(true);
  });

  it('counts reaching the level exactly as crossing it', () => {
    expect(crossed('crossing_up', 100, 99, 100)).toBe(true);
    expect(crossed('crossing_down', 100, 101, 100)).toBe(true);
  });

  it('does not fire while the price stays on one side', () => {
    expect(crossed('crossing_up', 100, 90, 95)).toBe(false);
    expect(crossed('crossing_up', 100, 105, 110)).toBe(false);
    expect(crossed('crossing_down', 100, 110, 105)).toBe(false);
    expect(crossed('crossing', 100, 95, 96)).toBe(false);
  });

  it('handles a price that sits exactly on the level', () => {
    expect(crossed('crossing_up', 100, 100, 101)).toBe(true); // leaving it upward
    expect(crossed('crossing_down', 100, 100, 99)).toBe(true); // leaving it downward
    expect(crossed('crossing_up', 100, 100, 100)).toBe(false); // staying on it
    expect(crossed('crossing', 100, 100, 100)).toBe(false);
    expect(crossed('crossing_up', 100, 100, 99)).toBe(false); // wrong direction
  });

  it('is not fooled by a price that was already past the level', () => {
    // An "up" alert for 100 created while the price is 120 waits for it to come back and rise again.
    expect(crossed('crossing_up', 100, 120, 125)).toBe(false);
    expect(crossed('crossing_up', 100, 120, 95)).toBe(false);
  });

  it('works for small, FX-like prices', () => {
    expect(crossed('crossing_up', 1.0843, 1.0842, 1.0844)).toBe(true);
    expect(crossed('crossing_down', 0.000123, 0.000124, 0.000122)).toBe(true);
  });
});

describe('suggestCondition', () => {
  it('waits for the price to rise when the level is above it, and fall when below', () => {
    expect(suggestCondition(110, 100)).toBe('crossing_up');
    expect(suggestCondition(90, 100)).toBe('crossing_down');
  });

  it('accepts either direction at the current price, or when the price is unknown', () => {
    expect(suggestCondition(100, 100)).toBe('crossing');
    expect(suggestCondition(100, null)).toBe('crossing');
  });
});

describe('shouldFire', () => {
  const now = 1_000_000;

  it('fires on a crossing', () => {
    expect(shouldFire(alert(), 99, 101, now)).toBe(true);
  });

  it('has nothing to say without a previous price', () => {
    expect(shouldFire(alert(), null, 101, now)).toBe(false);
  });

  it('never fires a paused or already-triggered alert', () => {
    expect(shouldFire(alert({ status: 'paused' }), 99, 101, now)).toBe(false);
    expect(shouldFire(alert({ status: 'triggered' }), 99, 101, now)).toBe(false);
  });

  it('lets an every-time alert fire again only after the cooldown', () => {
    const repeating = alert({ mode: 'every', triggeredAt: now - 10_000 });
    expect(shouldFire(repeating, 99, 101, now)).toBe(false);
    expect(shouldFire({ ...repeating, triggeredAt: now - COOLDOWN_MS }, 99, 101, now)).toBe(true);
  });

  it('does not apply the cooldown to the first firing of an every-time alert', () => {
    expect(shouldFire(alert({ mode: 'every', triggeredAt: null }), 99, 101, now)).toBe(true);
  });
});

describe('afterFiring', () => {
  it('finishes a once-only alert and records what tripped it', () => {
    const done = afterFiring(alert(), 101.5, 5000);
    expect(done).toMatchObject({ status: 'triggered', triggeredAt: 5000, triggerPrice: 101.5, triggerCount: 1, basePrice: 101.5 });
  });

  it('keeps an every-time alert armed, measuring the next crossing from where it fired', () => {
    const rearmed = afterFiring(alert({ mode: 'every', triggerCount: 2 }), 101.5, 5000);
    expect(rearmed).toMatchObject({ status: 'active', triggerCount: 3, basePrice: 101.5 });
  });

  it('does not modify the alert it was given', () => {
    const original = alert();
    afterFiring(original, 101, 5);
    expect(original.status).toBe('active');
    expect(original.triggerCount).toBe(0);
  });
});

describe('newAlert', () => {
  it('starts active, unfired, and measuring from the current price', () => {
    const a = newAlert({
      id: 'x', symbol: 'binance:BTCUSDT', condition: 'crossing_up', price: 250, basePrice: 240,
      message: '  earnings  ', mode: 'once', now: 42,
    });
    expect(a).toMatchObject({
      id: 'x', status: 'active', basePrice: 240, message: 'earnings', createdAt: 42,
      triggeredAt: null, triggerPrice: null, triggerCount: 0,
    });
  });
});

describe('draftProblem and parsePrice', () => {
  const ok = { symbol: 'binance:BTCUSDT', price: '250.5', message: '' };

  it('accepts a good draft', () => {
    expect(draftProblem(ok)).toBeNull();
  });

  it('says what is wrong in words', () => {
    expect(draftProblem({ ...ok, symbol: ' ' })).toMatch(/symbol/i);
    expect(draftProblem({ ...ok, price: '' })).toMatch(/price/i);
    expect(draftProblem({ ...ok, price: 'abc' })).toMatch(/price/i);
    expect(draftProblem({ ...ok, price: '0' })).toMatch(/above zero/i);
    expect(draftProblem({ ...ok, price: '-3' })).toMatch(/above zero/i);
    expect(draftProblem({ ...ok, message: 'x'.repeat(201) })).toMatch(/too long/i);
  });

  it('reads prices typed with thousands separators', () => {
    expect(draftProblem({ ...ok, price: '1,234.50' })).toBeNull();
    expect(parsePrice('1,234.50')).toBe(1234.5);
    expect(parsePrice(' 250 ')).toBe(250);
  });

  it('refuses what is not a usable price', () => {
    for (const bad of ['', '  ', 'abc', '0', '-1', 'Infinity', '1e999']) expect(parsePrice(bad)).toBeNull();
  });
});

describe('wording', () => {
  it('describes what each alert waits for', () => {
    expect(describeCondition('crossing_up', '250.00')).toBe('Crosses above 250.00');
    expect(describeCondition('crossing_down', '250.00')).toBe('Crosses below 250.00');
    expect(describeCondition('crossing', '250.00')).toBe('Crosses 250.00');
  });

  it('announces a fired alert with the symbol, the direction and the note', () => {
    const up = announcement(alert({ message: 'take profit' }), '251.10', '250.00', 'AAPL');
    expect(up.title).toBe('AAPL alert');
    expect(up.body).toBe('AAPL rose to 251.10 (alert level 250.00) — take profit');
    expect(announcement(alert({ condition: 'crossing_down' }), '249', '250', 'AAPL').body).toContain('fell to');
    expect(announcement(alert({ condition: 'crossing' }), '250', '250', 'AAPL').body).toContain('crossed');
    expect(announcement(alert(), '251', '250', 'AAPL').body).not.toContain('—');
  });
});

describe('roundForDisplay', () => {
  it('keeps two decimals for ordinary prices and drops trailing zeros', () => {
    expect(roundForDisplay(1048.194354)).toBe('1048.19');
    expect(roundForDisplay(250)).toBe('250');
    expect(roundForDisplay(336.1)).toBe('336.1');
  });

  it('keeps the precision small prices carry', () => {
    expect(roundForDisplay(1.08432199)).toBe('1.0843');
    expect(roundForDisplay(0.000123456789)).toBe('0.000123');
    expect(roundForDisplay(35.5)).toBe('35.5');
  });
});
