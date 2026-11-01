import type { StrategyState, StrategyTrade } from '@luxalgo/vela/plugin';

/** Turns what the engine reports about a strategy — a flat account state and a list of
 *  round trips — into what TradingView's Strategy Tester shows: a trade list with net
 *  P&L, run-up and drawdown, an equity curve, and the performance summary.
 *
 *  The engine reports fills, not an equity history, so trade P&L, commission, run-up and
 *  drawdown are derived here from the trades and the chart's bars (and held to the
 *  engine's own per-trade totals by `tester.engine.test.ts`). Everything is computed from the
 *  trade rows so the summary always adds up to the list beneath it. Equity, run-up and
 *  drawdown are measured on bar closes (TradingView also looks inside bars), so they can
 *  differ slightly from TradingView — the tester says results are approximate. */

export interface TesterBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type CommissionType = 'percent' | 'cash_per_order' | 'cash_per_contract';

export interface Commission {
  type: CommissionType;
  value: number;
}

export interface TesterInput {
  state: Pick<StrategyState, 'initialCapital' | 'equity' | 'cagr' | 'sharpe' | 'sortino' | 'outperformance'>;
  trades: readonly StrategyTrade[];
  bars: readonly TesterBar[];
  commission: Commission;
}

export interface TradeRow {
  /** 1-based, in entry order — TradingView's "Trade #". */
  n: number;
  side: 'long' | 'short';
  qty: number;
  entryTime: number;
  entryPrice: number;
  entrySignal: string;
  exitTime: number | null;
  exitPrice: number | null;
  exitSignal: string | null;
  open: boolean;
  /** Net of commission. For an open trade, the unrealised P&L at the last bar. */
  pnl: number;
  /** `pnl` as a percentage of the position's value at entry. */
  pnlPct: number;
  commission: number;
  /** Best unrealised gain while the trade was held (never negative). */
  runup: number;
  /** Worst unrealised loss while the trade was held (never negative). */
  drawdown: number;
  /** Running total of net P&L over closed trades, up to and including this one. */
  cumPnl: number;
  /** Bars the trade spanned, entry and exit bars included. */
  bars: number;
  /** The broker emulator force-closed it. */
  marginCall: boolean;
}

export interface CurvePoint {
  time: number;
  value: number;
}

/** Statistics over a set of trades: the whole list, or just the longs or the shorts. */
export interface TradeStats {
  /** Closed trades only. */
  netProfit: number;
  grossProfit: number;
  /** A magnitude (never negative). */
  grossLoss: number;
  /** Null when there are no losing trades (undefined, shown as a dash). */
  profitFactor: number | null;
  commissionPaid: number;
  openPnl: number;
  closedTrades: number;
  openTrades: number;
  winning: number;
  losing: number;
  even: number;
  /** Winning share of closed trades, 0 to 100; null with no closed trades. */
  percentProfitable: number | null;
  avgPnl: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  ratioAvgWinLoss: number | null;
  largestWin: number;
  largestLoss: number;
  avgBarsAll: number | null;
  avgBarsWin: number | null;
  avgBarsLoss: number | null;
}

export interface Summary extends TradeStats {
  initialCapital: number;
  equity: number;
  netProfitPct: number;
  /** Net profit plus open P&L: TradingView's headline "Total P&L". */
  totalPnl: number;
  totalPnlPct: number;
  /** Null with no trades: buy & hold starts at the first entry. */
  buyHold: number | null;
  buyHoldPct: number | null;
  maxRunup: number;
  maxRunupPct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
}

/** Figures only the engine computes, over every bar of the backtest. Each is null when the engine
 *  didn't report it (a span too short to annualize, an account wiped out, an older engine). */
export interface EngineFigures {
  /** Compound annual growth of the account, in percent. */
  cagr: number | null;
  /** On monthly equity returns. */
  sharpe: number | null;
  sortino: number | null;
  /** Net profit beyond buy & hold, in account currency. */
  outperformance: number | null;
}

export interface TesterReport {
  rows: TradeRow[];
  equity: CurvePoint[];
  buyHold: CurvePoint[];
  summary: Summary;
  long: TradeStats;
  short: TradeStats;
  engine: EngineFigures;
  warnings: string[];
}

const finite = (v: number | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The engine's own figures, as reported. PineTS reports Sharpe and Sortino as 0 when it has fewer
 *  than two months of equity to measure; both exactly 0 is that, not a result, so neither is shown. */
export function engineFigures(state: TesterInput['state']): EngineFigures {
  const unmeasured = state.sharpe === 0 && state.sortino === 0;
  return {
    cagr: finite(state.cagr),
    sharpe: unmeasured ? null : finite(state.sharpe),
    sortino: unmeasured ? null : finite(state.sortino),
    outperformance: finite(state.outperformance),
  };
}

export function commissionFor(commission: Commission, qty: number, price: number): number {
  switch (commission.type) {
    case 'percent':
      return (qty * price * commission.value) / 100;
    case 'cash_per_order':
      return commission.value;
    case 'cash_per_contract':
      return qty * commission.value;
  }
}

/** Reads a commission setting from a strategy's effective props, tolerating the engine's
 *  spellings (`percent`, `strategy.commission.percent`). Unknown types mean no commission
 *  rather than a wrong one. */
export function parseCommission(type: unknown, value: unknown): Commission {
  const v = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  const t = typeof type === 'string' ? type.toLowerCase() : '';
  if (v > 0 && t.endsWith('percent')) return { type: 'percent', value: v };
  if (v > 0 && t.endsWith('cash_per_order')) return { type: 'cash_per_order', value: v };
  if (v > 0 && t.endsWith('cash_per_contract')) return { type: 'cash_per_contract', value: v };
  return { type: 'percent', value: 0 };
}

/** Index of the last bar whose time is <= `time`, or -1 when `time` precedes every bar. */
function barIndexAtOrBefore(bars: readonly TesterBar[], time: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function tradeStats(rows: readonly TradeRow[]): TradeStats {
  const closedRows = rows.filter((r) => !r.open);
  const openRows = rows.filter((r) => r.open);
  const wins = closedRows.filter((r) => r.pnl > 0);
  const losses = closedRows.filter((r) => r.pnl < 0);
  const grossProfit = wins.reduce((a, r) => a + r.pnl, 0);
  const grossLoss = losses.reduce((a, r) => a - r.pnl, 0); // subtracting avoids a -0 when there are no losses
  const avgWin = mean(wins.map((r) => r.pnl));
  const avgLoss = mean(losses.map((r) => r.pnl));
  return {
    netProfit: grossProfit - grossLoss,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    commissionPaid: rows.reduce((a, r) => a + r.commission, 0),
    openPnl: openRows.reduce((a, r) => a + r.pnl, 0),
    closedTrades: closedRows.length,
    openTrades: openRows.length,
    winning: wins.length,
    losing: losses.length,
    even: closedRows.length - wins.length - losses.length,
    percentProfitable: closedRows.length ? (wins.length / closedRows.length) * 100 : null,
    avgPnl: mean(closedRows.map((r) => r.pnl)),
    avgWin,
    avgLoss,
    ratioAvgWinLoss: avgWin !== null && avgLoss !== null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null,
    largestWin: wins.reduce((m, r) => Math.max(m, r.pnl), 0),
    largestLoss: losses.reduce((m, r) => Math.min(m, r.pnl), 0),
    avgBarsAll: mean(closedRows.map((r) => r.bars)),
    avgBarsWin: mean(wins.map((r) => r.bars)),
    avgBarsLoss: mean(losses.map((r) => r.bars)),
  };
}

export function buildReport(input: TesterInput): TesterReport {
  const { bars, commission } = input;
  const initialCapital = input.state.initialCapital;
  const lastIdx = bars.length - 1;
  const lastClose = lastIdx >= 0 ? bars[lastIdx].close : 0;

  const ordered = [...input.trades].sort((a, b) => a.entry.time - b.entry.time);

  // Difference arrays over bar indices: realised P&L accumulates from the exit bar on,
  // unrealised P&L applies only while a trade is held.
  const realisedFrom = new Float64Array(bars.length + 1);
  const unrealised = new Float64Array(bars.length);

  const rows: TradeRow[] = [];
  let cumPnl = 0;

  ordered.forEach((t, i) => {
    const dir = t.side === 'long' ? 1 : -1;
    const entryPrice = t.entry.price;
    const entryComm = commissionFor(commission, t.qty, entryPrice);
    const exitPrice = t.exit?.price ?? null;
    const exitComm = t.exit ? commissionFor(commission, t.qty, t.exit.price) : 0;
    const entryIdx = barIndexAtOrBefore(bars, t.entry.time);
    const exitIdx = t.exit ? barIndexAtOrBefore(bars, t.exit.time) : -1;
    // The span the trade was held, on bars we have; an open trade runs to the last bar.
    const from = Math.max(entryIdx, 0);
    const to = t.open || !t.exit ? lastIdx : Math.max(exitIdx, from);

    let runupPx = 0;
    let drawdownPx = 0;
    for (let b = from; b <= to && b < bars.length; b++) {
      const bar = bars[b];
      const favourable = dir === 1 ? bar.high - entryPrice : entryPrice - bar.low;
      const adverse = dir === 1 ? entryPrice - bar.low : bar.high - entryPrice;
      if (favourable > runupPx) runupPx = favourable;
      if (adverse > drawdownPx) drawdownPx = adverse;
    }

    const closed = !t.open && exitPrice !== null;
    const gross = closed ? dir * (exitPrice - entryPrice) * t.qty : dir * (lastClose - entryPrice) * t.qty;
    const pnl = gross - entryComm - exitComm;
    if (closed) cumPnl += pnl;

    // Equity: unrealised while held (entry commission already paid), realised after.
    if (entryIdx >= 0) {
      const heldUntil = closed ? Math.max(exitIdx, entryIdx) : lastIdx + 1;
      for (let b = entryIdx; b < heldUntil && b < bars.length; b++) {
        unrealised[b] += dir * (bars[b].close - entryPrice) * t.qty - entryComm;
      }
    }
    if (closed) realisedFrom[Math.max(exitIdx, 0)] += pnl;

    rows.push({
      n: i + 1,
      side: t.side,
      qty: t.qty,
      entryTime: t.entry.time,
      entryPrice,
      entrySignal: t.entry.comment || t.entry.id,
      exitTime: t.exit?.time ?? null,
      exitPrice,
      exitSignal: t.exit ? t.exit.comment || t.exit.id : null,
      open: !closed,
      pnl,
      pnlPct: entryPrice * t.qty !== 0 ? (pnl / (entryPrice * t.qty)) * 100 : 0,
      commission: entryComm + exitComm,
      runup: runupPx * t.qty,
      drawdown: drawdownPx * t.qty,
      cumPnl,
      bars: to >= from ? to - from + 1 : 0,
      marginCall: t.exit?.id === 'Margin call' || t.exit?.comment === 'Margin call',
    });
  });

  // Equity curve on bar closes, with the peak/trough sweep for run-up and drawdown.
  const equity: CurvePoint[] = [];
  let realised = 0;
  let peak = initialCapital;
  let trough = initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let maxRunup = 0;
  let maxRunupPct = 0;
  for (let b = 0; b < bars.length; b++) {
    realised += realisedFrom[b];
    const value = initialCapital + realised + unrealised[b];
    equity.push({ time: bars[b].time, value });
    if (value > peak) peak = value;
    if (value < trough) trough = value;
    const dd = peak - value;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (peak > 0 && dd / peak > maxDrawdownPct) maxDrawdownPct = dd / peak;
    // Run-up mirrors drawdown: the biggest rise above the lowest equity seen so far.
    const ru = value - trough;
    if (ru > maxRunup) maxRunup = ru;
    if (trough > 0 && ru / trough > maxRunupPct) maxRunupPct = ru / trough;
  }

  // Buy & hold, as TradingView and the engine measure it: the whole starting capital in at the
  // first entry's price, held to the last close. Before that entry, the curve is the capital.
  const buyHold: CurvePoint[] = [];
  let buyHoldPnl: number | null = null;
  let buyHoldPct: number | null = null;
  const first = ordered[0];
  if (first && first.entry.price > 0 && bars.length > 0) {
    const from = barIndexAtOrBefore(bars, first.entry.time);
    const gain = (close: number) => close / first.entry.price - 1;
    bars.forEach((bar, b) => buyHold.push({ time: bar.time, value: b < from ? initialCapital : initialCapital * (1 + gain(bar.close)) }));
    buyHoldPnl = initialCapital * gain(lastClose);
    buyHoldPct = gain(lastClose) * 100;
  }

  const all = tradeStats(rows);
  const finalEquity = equity.length ? equity[equity.length - 1].value : initialCapital;
  const pctOfCapital = (v: number) => (initialCapital ? (v / initialCapital) * 100 : 0);

  const summary: Summary = {
    ...all,
    initialCapital,
    equity: finalEquity,
    netProfitPct: pctOfCapital(all.netProfit),
    totalPnl: all.netProfit + all.openPnl,
    totalPnlPct: pctOfCapital(all.netProfit + all.openPnl),
    buyHold: buyHoldPnl,
    buyHoldPct,
    maxRunup,
    maxRunupPct: maxRunupPct * 100,
    maxDrawdown,
    maxDrawdownPct: maxDrawdownPct * 100,
  };

  const warnings: string[] = [];
  const marginCalls = rows.filter((r) => r.marginCall).length;
  if (marginCalls > 0) {
    warnings.push(
      `${marginCalls} trade${marginCalls === 1 ? ' was' : 's were'} closed by a margin call. This usually means the order size ` +
        `used all of your equity, so commission pushed it over the margin limit. Size orders at 99% of equity or less, or set ` +
        `both margins to 0 in Properties.`,
    );
  }
  if (bars.length === 0 && rows.length > 0) warnings.push('The chart has no bars loaded, so the equity curve is unavailable.');

  return {
    rows,
    equity,
    buyHold,
    summary,
    long: tradeStats(rows.filter((r) => r.side === 'long')),
    short: tradeStats(rows.filter((r) => r.side === 'short')),
    engine: engineFigures(input.state),
    warnings,
  };
}
