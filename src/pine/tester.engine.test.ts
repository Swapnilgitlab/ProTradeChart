import { describe, expect, it } from 'vitest';
import { Indicator, PineTS } from 'pinets';
import { PineEngine } from '@luxalgo/vela-pinets';
import type { ExecutionRequest } from '@luxalgo/vela/plugin';
import { buildReport, parseCommission } from './tester';

/** These run the real PineTS engine (in-process) and hold the tester's derived numbers to
 *  PineTS's own ledger. They exist because the tester re-derives P&L and commission from
 *  fills: if the engine changes how it charges commission, this is where it shows. */

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

function makeBars(n: number): ExecutionRequest['bars'] {
  const out: ExecutionRequest['bars'] = [];
  let prev = 100;
  for (let i = 0; i < n; i++) {
    const close = 100 + 20 * Math.sin(i / 12) + i * 0.05 + 3 * Math.sin(i * 1.7);
    out.push({
      time: T0 + i * DAY,
      open: prev,
      high: Math.max(prev, close) + 1.5,
      low: Math.min(prev, close) - 1.5,
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

async function runPineTsDirect(source: string) {
  const klines = BARS.map((b) => ({
    openTime: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume ?? 0,
    closeTime: b.time + DAY - 1,
    quoteAssetVolume: 0,
    numberOfTrades: 0,
    takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0,
    ignore: 0,
  }));
  const ctx = await new PineTS(klines, 'TEST', 'D').run(new Indicator(source));
  return ctx.strategy!;
}

const VARIANTS: [string, string][] = [
  ['no commission, fixed size', 'default_qty_type=strategy.fixed, default_qty_value=10'],
  ['percent commission, 50% of equity', 'default_qty_type=strategy.percent_of_equity, default_qty_value=50, commission_type=strategy.commission.percent, commission_value=0.1'],
  ['cash per order', 'default_qty_type=strategy.fixed, default_qty_value=10, commission_type=strategy.commission.cash_per_order, commission_value=3'],
  ['cash per contract', 'default_qty_type=strategy.fixed, default_qty_value=10, commission_type=strategy.commission.cash_per_contract, commission_value=0.25'],
];

describe('tester vs the real engine', () => {
  for (const [label, declaration] of VARIANTS) {
    it(`matches PineTS's ledger: ${label}`, async () => {
      const source = strategy(declaration);
      const [viaVela, direct] = await Promise.all([runViaVela(source), runPineTsDirect(source)]);
      const report = buildReport({
        state: viaVela.state,
        trades: viaVela.trades,
        bars: BARS,
        commission: parseCommission(viaVela.props.commission_type, viaVela.props.commission_value),
      });

      expect(report.rows.length).toBe(direct.closedtrades.length + direct.opentrades.length);
      expect(report.rows.length).toBeGreaterThan(2);

      // Per trade: our net P&L (with commission) equals the engine's.
      const engineProfit = new Map(direct.closedtrades.map((t) => [t.entry_time, t.profit ?? NaN]));
      for (const row of report.rows.filter((r) => !r.open)) {
        expect(row.pnl).toBeCloseTo(engineProfit.get(row.entryTime) ?? NaN, 6);
      }

      // The equity curve ends where the engine says the account ended.
      const last = report.equity[report.equity.length - 1].value;
      expect(last).toBeCloseTo(direct.equity, 6);
      expect(report.summary.equity).toBeCloseTo(viaVela.state.equity, 6);
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
