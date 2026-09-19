import { describe, expect, it } from 'vitest';
import type { StrategyTrade } from '@luxalgo/vela/plugin';
import { buildReport, type TesterBar } from '../../pine/tester';
import { performanceSections } from './performance';

const bars: TesterBar[] = [
  { time: 0, open: 100, high: 101, low: 99, close: 100 },
  { time: 1000, open: 100, high: 105, low: 98, close: 104 },
  { time: 2000, open: 104, high: 112, low: 103, close: 108 },
  { time: 3000, open: 108, high: 111, low: 102, close: 110 },
];

const trade = (side: 'long' | 'short', t: number, p: number, exitT: number, exitP: number): StrategyTrade => ({
  id: `${side}${t}`,
  side,
  qty: 1,
  open: false,
  entry: { id: 'e', time: t, price: p },
  exit: { id: 'x', time: exitT, price: exitP },
});

describe('performanceSections', () => {
  const report = buildReport({
    state: { initialCapital: 1000, equity: 0 },
    trades: [trade('long', 0, 100, 2000, 110), trade('short', 1000, 104, 3000, 108)], // +10, -4
    bars,
    commission: { type: 'percent', value: 0 },
  });
  const [returns, trades] = performanceSections(report, 'USD');
  const row = (label: string) => [...returns.rows, ...trades.rows].find((r) => r.label === label)!;

  it('splits each trade statistic into All, Long and Short', () => {
    expect(row('Net profit').all).toMatchObject({ text: '+6.00 USD', tone: 'pos' });
    expect(row('Net profit').long).toMatchObject({ text: '+10.00 USD', tone: 'pos' });
    expect(row('Net profit').short).toMatchObject({ text: '−4.00 USD', tone: 'neg' });
    expect(row('Total closed trades').all.text).toBe('2');
    expect(row('Total closed trades').long.text).toBe('1');
    expect(row('Percent profitable').all.text).toBe('50.00%');
    expect(row('Percent profitable').short.text).toBe('0.00%');
  });

  it('shows gross loss as a negative amount', () => {
    expect(row('Gross loss').all).toMatchObject({ text: '−4.00 USD', tone: 'neg' });
    expect(row('Gross loss').long.text).toBe('0.00 USD');
  });

  it('leaves account-wide rows blank under Long and Short', () => {
    for (const label of ['Buy & hold return', 'Max run-up', 'Max drawdown']) {
      expect(row(label).long.text).toBe('—');
      expect(row(label).short.text).toBe('—');
    }
    expect(row('Buy & hold return').all.sub).toBe('+10.00%');
  });

  it('uses a dash where a statistic is undefined', () => {
    expect(row('Profit factor').long.text).toBe('—'); // no losing longs
    expect(row('Profit factor').all.text).toBe('2.50');
  });
});
