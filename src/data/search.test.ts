import { describe, expect, it } from 'vitest';
import { matchScore, rankSymbols } from './search';
import { quoteFromBars, quoteRefreshMs } from './quotes';

describe('matchScore', () => {
  it('orders exact, prefix, substring, then description matches', () => {
    expect(matchScore('btc', 'BTC')).toBe(0);
    expect(matchScore('btc', 'BTCUSDT')).toBe(1);
    expect(matchScore('btc', 'WBTCUSDT')).toBe(2);
    expect(matchScore('bitcoin', 'XBT', 'Bitcoin / Tether')).toBe(3);
    expect(matchScore('doge', 'BTCUSDT', 'Bitcoin / Tether')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(matchScore('BtC', 'btcusdt')).toBe(1);
  });
});

describe('rankSymbols', () => {
  const symbols = [
    { ticker: 'WBTCUSDT', description: 'Wrapped Bitcoin' },
    { ticker: 'BTCUSDT', description: 'Bitcoin / TetherUS' },
    { ticker: 'ETHBTC', description: 'Ethereum / Bitcoin' },
    { ticker: 'BTC', description: 'Bitcoin' },
    { ticker: 'DOGEUSDT', description: 'Dogecoin' },
  ];

  it('puts the best matches first and drops non-matches', () => {
    expect(rankSymbols('btc', symbols, 10).map((s) => s.ticker)).toEqual(['BTC', 'BTCUSDT', 'WBTCUSDT', 'ETHBTC']);
  });

  it('applies the limit after ranking', () => {
    expect(rankSymbols('btc', symbols, 2).map((s) => s.ticker)).toEqual(['BTC', 'BTCUSDT']);
  });

  it('prefers the dollar-quoted pair among equally good matches', () => {
    const pairs = [
      { ticker: 'BTCU', description: 'BTC / U' },
      { ticker: 'BTCEUR', description: 'BTC / EUR' },
      { ticker: 'BTCUSDT', description: 'BTC / USDT' },
    ];
    expect(rankSymbols('btc', pairs, 3).map((s) => s.ticker)).toEqual(['BTCUSDT', 'BTCU', 'BTCEUR']);
  });

  it('breaks remaining ties by the shorter ticker', () => {
    const tied = [
      { ticker: 'ABCDEF', description: '' },
      { ticker: 'ABCD', description: '' },
    ];
    expect(rankSymbols('ab', tied, 5).map((s) => s.ticker)).toEqual(['ABCD', 'ABCDEF']);
  });
});

describe('quoteFromBars', () => {
  it('computes the change between the last two closes', () => {
    const q = quoteFromBars([100, 110]);
    expect(q.price).toBe(110);
    expect(q.changePercent).toBeCloseTo(10);
  });

  it('degrades when there is little or no data', () => {
    expect(quoteFromBars([])).toEqual({ price: null, changePercent: null });
    expect(quoteFromBars([50])).toEqual({ price: 50, changePercent: null });
    expect(quoteFromBars([0, 5]).changePercent).toBeNull();
  });
});

describe('quoteRefreshMs', () => {
  const many = (provider: string, n: number) => Array.from({ length: n }, (_, i) => `${provider}:S${i}`);

  it('refreshes every 30 seconds however long a Yahoo, Dhan or imported list is', () => {
    expect(quoteRefreshMs([])).toBe(30_000);
    expect(quoteRefreshMs(many('yahoo', 500))).toBe(30_000);
    expect(quoteRefreshMs([...many('dhan', 300), ...many('csv', 50)])).toBe(30_000);
  });

  it('stretches for symbols that cost one request each', () => {
    expect(quoteRefreshMs(many('binance', 10))).toBe(30_000);
    expect(quoteRefreshMs(many('binance', 100))).toBe(70_000);
    expect(quoteRefreshMs([...many('yahoo', 100), ...many('coinbase', 100)])).toBe(70_000);
  });
});

describe('quoteRefreshMs with Zerodha', () => {
  it('quotes a whole Zerodha list in a few requests, so a long one refreshes as often as a short one', () => {
    const many = Array.from({ length: 500 }, (_, i) => `zerodha:NSE:S${i}`);
    expect(quoteRefreshMs(many)).toBe(30_000);
  });
});
