import { describe, expect, it } from 'vitest';
import type { StrategyTrade } from '@luxalgo/vela/plugin';
import { buildReport, commissionFor, parseCommission, type TesterBar } from './tester';

const bar = (i: number, o: number, h: number, l: number, c: number): TesterBar => ({ time: i * 1000, open: o, high: h, low: l, close: c });

// Five bars; every expectation below is worked out by hand from these.
const BARS: TesterBar[] = [
  bar(0, 100, 101, 99, 100),
  bar(1, 100, 105, 98, 104),
  bar(2, 104, 112, 103, 108),
  bar(3, 108, 111, 102, 110),
  bar(4, 110, 112, 100, 101),
];

interface Exit {
  t: number;
  p: number;
  id?: string;
  comment?: string;
}

/** A round trip: entered at time `t` (ms) and price `p`, closed by `exit` or still open. */
function mk(t: number, p: number, qty: number, exit?: Exit, side: 'long' | 'short' = 'long'): StrategyTrade {
  return {
    id: `t${t}`,
    side,
    qty,
    open: !exit,
    entry: { id: side === 'long' ? 'Long' : 'Short', time: t, price: p },
    exit: exit && { id: exit.id ?? 'close', time: exit.t, price: exit.p, comment: exit.comment },
  };
}

const NO_COMMISSION = { type: 'percent', value: 0 } as const;
const state = { initialCapital: 1000, equity: 0 };

describe('buildReport', () => {
  it('derives P&L, run-up, drawdown and equity for a closed and an open trade', () => {
    const closed = mk(1000, 100, 10, { t: 3000, p: 110 });
    const open = mk(4000, 110, 5, undefined, 'short');
    const r = buildReport({ state, trades: [open, closed], bars: BARS, commission: NO_COMMISSION });

    // Sorted by entry time regardless of input order.
    expect(r.rows.map((x) => [x.n, x.side, x.open])).toEqual([
      [1, 'long', false],
      [2, 'short', true],
    ]);
    const [a, b] = r.rows;
    expect(a.pnl).toBe(100);
    expect(a.pnlPct).toBe(10);
    expect(a.runup).toBe(120); // high 112 over entry 100, x10
    expect(a.drawdown).toBe(20); // low 98 under entry 100, x10
    expect(a.bars).toBe(3);
    expect(a.cumPnl).toBe(100);
    // The short is marked to the last close: (110 - 101) x 5.
    expect(b.pnl).toBe(45);
    expect(b.runup).toBe(50); // low 100 under entry 110, x5
    expect(b.drawdown).toBe(10); // high 112 over entry 110, x5
    expect(b.cumPnl).toBe(100); // an open trade doesn't join the running total

    expect(r.equity.map((p) => p.value)).toEqual([1000, 1040, 1080, 1100, 1145]);
    expect(r.summary).toMatchObject({
      netProfit: 100,
      grossProfit: 100,
      grossLoss: 0,
      profitFactor: null,
      openPnl: 45,
      totalPnl: 145,
      equity: 1145,
      closedTrades: 1,
      openTrades: 1,
      winning: 1,
      losing: 0,
      percentProfitable: 100,
    });
    // 1000 of capital in at the first open (100), held to the last close (101).
    expect(r.summary.buyHold).toBeCloseTo(10, 9);
    expect(r.summary.buyHoldPct).toBeCloseTo(1, 9);
  });

  it('measures drawdown from the equity peak and run-up from the equity low', () => {
    const t = mk(0, 100, 10, { t: 3000, p: 90 });
    const r = buildReport({ state, trades: [t], bars: BARS.slice(0, 4), commission: NO_COMMISSION });
    expect(r.equity.map((p) => p.value)).toEqual([1000, 1040, 1080, 900]);
    expect(r.summary.maxDrawdown).toBe(180);
    expect(r.summary.maxDrawdownPct).toBeCloseTo((180 / 1080) * 100, 9);
    expect(r.summary.maxRunup).toBe(80);
    expect(r.summary.maxRunupPct).toBeCloseTo(8, 9);
    expect(r.summary).toMatchObject({ netProfit: -100, grossLoss: 100, losing: 1, percentProfitable: 0, largestLoss: -100 });
  });

  it('charges commission on both sides and shows it in the equity curve', () => {
    const t = mk(1000, 100, 10, { t: 3000, p: 110 });
    const r = buildReport({ state, trades: [t], bars: BARS, commission: { type: 'percent', value: 1 } });
    expect(r.rows[0].commission).toBeCloseTo(21, 9); // 10 on entry, 11 on exit
    expect(r.rows[0].pnl).toBeCloseTo(79, 9);
    expect(r.summary.commissionPaid).toBeCloseTo(21, 9);
    // Entry commission is already in equity while the trade is held: 1000 + 40 - 10.
    expect(r.equity[1].value).toBeCloseTo(1030, 9);
    expect(r.equity[3].value).toBeCloseTo(1079, 9);
  });

  it('supports the other commission models', () => {
    expect(commissionFor({ type: 'cash_per_order', value: 2 }, 10, 100)).toBe(2);
    expect(commissionFor({ type: 'cash_per_contract', value: 0.5 }, 10, 100)).toBe(5);
    expect(commissionFor({ type: 'percent', value: 0.1 }, 10, 100)).toBeCloseTo(1, 12);
  });

  it('computes the trade-quality averages over closed trades only', () => {
    const win = mk(0, 100, 1, { t: 2000, p: 110 }); // +10 over 3 bars
    const loss = mk(3000, 110, 1, { t: 4000, p: 104 }); // -6 over 2 bars
    const r = buildReport({ state, trades: [win, loss], bars: BARS, commission: NO_COMMISSION });
    expect(r.summary).toMatchObject({
      avgPnl: 2,
      avgWin: 10,
      avgLoss: -6,
      largestWin: 10,
      largestLoss: -6,
      avgBarsWin: 3,
      avgBarsLoss: 2,
      avgBarsAll: 2.5,
    });
    expect(r.summary.ratioAvgWinLoss).toBeCloseTo(10 / 6, 9);
    expect(r.summary.profitFactor).toBeCloseTo(10 / 6, 9);
    expect(r.rows.map((x) => x.cumPnl)).toEqual([10, 4]);
  });

  it('splits the statistics into longs and shorts', () => {
    const longWin = mk(0, 100, 1, { t: 2000, p: 110 }); // +10
    const shortLoss = mk(3000, 110, 1, { t: 4000, p: 114 }, 'short'); // -4
    const shortWin = mk(1000, 104, 2, { t: 3000, p: 100 }, 'short'); // +8
    const r = buildReport({ state, trades: [longWin, shortLoss, shortWin], bars: BARS, commission: NO_COMMISSION });
    expect(r.long).toMatchObject({ closedTrades: 1, netProfit: 10, percentProfitable: 100 });
    expect(r.short).toMatchObject({ closedTrades: 2, winning: 1, losing: 1, netProfit: 4, grossProfit: 8, grossLoss: 4 });
    expect(r.short.profitFactor).toBeCloseTo(2, 9);
    // The three add up to the whole.
    expect(r.long.netProfit + r.short.netProfit).toBeCloseTo(r.summary.netProfit, 9);
  });

  it('flags margin calls with advice', () => {
    const t = mk(1000, 100, 1, { t: 1000, p: 100, id: 'Margin call', comment: 'Margin call' });
    const r = buildReport({ state, trades: [t], bars: BARS, commission: NO_COMMISSION });
    expect(r.rows[0].marginCall).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/1 trade was closed by a margin call/);
  });

  it('handles no trades and no bars', () => {
    const none = buildReport({ state, trades: [], bars: BARS, commission: NO_COMMISSION });
    expect(none.rows).toEqual([]);
    expect(none.equity.every((p) => p.value === 1000)).toBe(true);
    expect(none.summary).toMatchObject({ closedTrades: 0, percentProfitable: null, avgPnl: null, netProfit: 0, equity: 1000 });

    const empty = buildReport({ state, trades: [], bars: [], commission: NO_COMMISSION });
    expect(empty.equity).toEqual([]);
    expect(empty.summary.equity).toBe(1000);
  });
});

describe('parseCommission', () => {
  it('accepts the engine spellings and ignores unknown or zero settings', () => {
    expect(parseCommission('percent', 0.1)).toEqual({ type: 'percent', value: 0.1 });
    expect(parseCommission('strategy.commission.percent', 0.1)).toEqual({ type: 'percent', value: 0.1 });
    expect(parseCommission('cash_per_order', 3)).toEqual({ type: 'cash_per_order', value: 3 });
    expect(parseCommission('cash_per_contract', 1)).toEqual({ type: 'cash_per_contract', value: 1 });
    expect(parseCommission('percent', 0).value).toBe(0);
    expect(parseCommission('nonsense', 5).value).toBe(0);
    expect(parseCommission(undefined, undefined).value).toBe(0);
  });
});
