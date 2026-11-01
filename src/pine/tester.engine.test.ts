import { describe, expect, it } from 'vitest';
import { PineEngine } from '@luxalgo/vela-pinets';
import type { ExecutionRequest } from '@luxalgo/vela/plugin';
import { buildReport, parseCommission } from './tester';

/** These run the real Pine engine (in-process, the same runtime as the app's worker) and hold
 *  the tester's derived numbers to the engine's own ledger. They exist because the tester
 *  re-derives P&L and commission from fills: if the engine changes how it fills (it rounds
 *  fills to the tick grid, as TradingView does) or charges commission, this is where it shows. */

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

/** Prices on a cent grid, as an exchange's are: the engine fills and marks on the tick grid. */
const cents = (x: number) => Math.round(x * 100) / 100;

function makeBars(n: number): ExecutionRequest['bars'] {
  const out: ExecutionRequest['bars'] = [];
  let prev = 100;
  for (let i = 0; i < n; i++) {
    const close = cents(100 + 20 * Math.sin(i / 12) + i * 0.05 + 3 * Math.sin(i * 1.7));
    out.push({
      time: T0 + i * DAY,
      open: prev,
      high: cents(Math.max(prev, close) + 1.5),
      low: cents(Math.min(prev, close) - 1.5),
      close,
      volume: 1000 + i,
    });
    prev = close;
  }
  return out;
}

const BARS = makeBars(300);

const strategy = (declaration: string) => `//@version=6
strategy("Cross", overlay=true, initial_capital=10000, ${declaration})
if ta.crossover(ta.sma(close, 5), ta.sma(close, 20))
    strategy.entry("Long", strategy.long)
if ta.crossunder(ta.sma(close, 5), ta.sma(close, 20))
    strategy.close("Long")
`;

async function runViaVela(source: string) {
  const engine = new PineEngine({ props: 'strategy' });
  const prepared = await engine.prepare(source, 'test');
  const session = await new Promise<ReturnType<PineEngine['execute']>>((resolve, reject) => {
    const s = engine.execute(
      { prepared, market: { symbol: 'TEST', timeframe: 'D' }, bars: BARS, mode: 'static' },
      { onModel: () => {}, onError: reject, onDone: () => resolve(s) },
    );
  });
  const ctx = await session.getContext?.(['strategy', 'trades']);
  if (!ctx?.strategy || !ctx.trades) throw new Error('the engine reported no strategy state');
  const props = Object.fromEntries((prepared.props ?? []).map((p) => [p.key, p.defval]));
  return { state: ctx.strategy, trades: ctx.trades, props };
}

const VARIANTS: [string, string][] = [
  ['no commission, fixed size', 'default_qty_type=strategy.fixed, default_qty_value=10'],
  ['percent commission, 50% of equity', 'default_qty_type=strategy.percent_of_equity, default_qty_value=50, commission_type=strategy.commission.percent, commission_value=0.1'],
  ['cash per order', 'default_qty_type=strategy.fixed, default_qty_value=10, commission_type=strategy.commission.cash_per_order, commission_value=3'],
  ['cash per contract', 'default_qty_type=strategy.fixed, default_qty_value=10, commission_type=strategy.commission.cash_per_contract, commission_value=0.25'],
];

describe('tester vs the real engine', () => {
  for (const [label, declaration] of VARIANTS) {
    it(`matches the engine's ledger: ${label}`, async () => {
      const source = strategy(declaration);
      const { state, trades, props } = await runViaVela(source);
      const report = buildReport({
        state,
        trades,
        bars: BARS,
        commission: parseCommission(props.commission_type, props.commission_value),
      });

      expect(report.rows.length).toBe(trades.length);
      expect(report.rows.length).toBeGreaterThan(2);

      // Per trade: our net P&L (with commission) equals the engine's.
      const engineProfit = new Map(trades.filter((t) => !t.open).map((t) => [t.entry.time, t.pnl ?? NaN]));
      for (const row of report.rows.filter((r) => !r.open)) {
        expect(row.pnl).toBeCloseTo(engineProfit.get(row.entryTime) ?? NaN, 6);
      }

      // The equity curve ends where the engine says the account ended.
      const last = report.equity[report.equity.length - 1].value;
      expect(last).toBeCloseTo(state.equity, 6);
      expect(report.summary.equity).toBeCloseTo(state.equity, 6);

      // Buy & hold is measured as the engine measures it, so its outperformance adds up.
      expect(report.summary.buyHold).toBeCloseTo(state.buyHoldPnl ?? NaN, 6);
      expect(report.summary.buyHoldPct).toBeCloseTo(state.buyHoldPct ?? NaN, 6);
      expect(report.engine.outperformance).toBeCloseTo(state.netPnl - (state.buyHoldPnl ?? NaN), 6);
      expect(report.buyHold[report.buyHold.length - 1].value).toBeCloseTo(state.initialCapital + (state.buyHoldPnl ?? NaN), 6);
      for (const figure of ['cagr', 'sharpe', 'sortino'] as const) expect(report.engine[figure]).toEqual(expect.any(Number));
    });
  }

  it('surfaces the engine margin call when a 100%-of-equity order meets commission', async () => {
    const source = strategy(
      'default_qty_type=strategy.percent_of_equity, default_qty_value=100, commission_type=strategy.commission.percent, commission_value=0.1',
    );
    const { state, trades, props } = await runViaVela(source);
    const report = buildReport({ state, trades, bars: BARS, commission: parseCommission(props.commission_type, props.commission_value) });
    expect(report.rows.some((r) => r.marginCall)).toBe(true);
    expect(report.warnings[0]).toMatch(/margin call/);
  });
});
