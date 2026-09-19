import type { TesterReport, TradeStats } from '../../pine/tester';
import { formatBars, formatMoney, formatPct, formatRatio, formatSignedMoney, pnlClass } from './format';

/** The Performance Summary table: TradingView's rows, with All / Long / Short columns.
 *  Rows that can only be measured on the whole account (drawdown, buy & hold) show a dash
 *  under Long and Short. */

export interface Cell {
  text: string;
  /** `pos`, `neg` or empty. */
  tone: string;
  /** A smaller second line, usually the same figure as a percentage. */
  sub?: string;
}

export interface StatRow {
  label: string;
  all: Cell;
  long: Cell;
  short: Cell;
}

export interface Section {
  title: string;
  rows: StatRow[];
}

const NONE: Cell = { text: '—', tone: '' };
const plain = (text: string): Cell => ({ text, tone: '' });
const money = (v: number, currency?: string, sub?: string): Cell => ({ text: formatSignedMoney(v, currency), tone: pnlClass(v), sub });
const count = (v: number): Cell => plain(String(v));
const optional = (v: number | null, fmt: (n: number) => string): Cell => (v === null ? NONE : plain(fmt(v)));
const optionalMoney = (v: number | null, currency?: string): Cell => (v === null ? NONE : money(v, currency));

/** A row computed from a `TradeStats`, once for each column. */
function perSide(label: string, report: TesterReport, cell: (s: TradeStats) => Cell): StatRow {
  return { label, all: cell(report.summary), long: cell(report.long), short: cell(report.short) };
}

function accountRow(label: string, all: Cell): StatRow {
  return { label, all, long: NONE, short: NONE };
}

export function performanceSections(report: TesterReport, currency?: string): Section[] {
  const s = report.summary;
  const returns: Section = {
    title: 'Returns',
    rows: [
      perSide('Net profit', report, (x) => money(x.netProfit, currency)),
      perSide('Gross profit', report, (x) => money(x.grossProfit, currency)),
      perSide('Gross loss', report, (x) => money(-x.grossLoss, currency)),
      perSide('Profit factor', report, (x) => optional(x.profitFactor, formatRatio)),
      perSide('Commission paid', report, (x) => plain(formatMoney(x.commissionPaid, currency))),
      perSide('Open P&L', report, (x) => money(x.openPnl, currency)),
      accountRow('Buy & hold return', money(s.buyHold, currency, formatPct(s.buyHoldPct, true))),
      accountRow('Max run-up', money(s.maxRunup, currency, formatPct(s.maxRunupPct))),
      accountRow('Max drawdown', { text: formatMoney(-s.maxDrawdown, currency), tone: s.maxDrawdown > 0 ? 'neg' : '', sub: formatPct(s.maxDrawdownPct) }),
    ],
  };
  const trades: Section = {
    title: 'Trades',
    rows: [
      perSide('Total closed trades', report, (x) => count(x.closedTrades)),
      perSide('Total open trades', report, (x) => count(x.openTrades)),
      perSide('Winning trades', report, (x) => count(x.winning)),
      perSide('Losing trades', report, (x) => count(x.losing)),
      perSide('Percent profitable', report, (x) => optional(x.percentProfitable, (v) => formatPct(v))),
      perSide('Avg P&L', report, (x) => optionalMoney(x.avgPnl, currency)),
      perSide('Avg winning trade', report, (x) => optionalMoney(x.avgWin, currency)),
      perSide('Avg losing trade', report, (x) => optionalMoney(x.avgLoss, currency)),
      perSide('Ratio avg win / avg loss', report, (x) => optional(x.ratioAvgWinLoss, formatRatio)),
      perSide('Largest winning trade', report, (x) => money(x.largestWin, currency)),
      perSide('Largest losing trade', report, (x) => money(x.largestLoss, currency)),
      perSide('Avg # bars in trades', report, (x) => optional(x.avgBarsAll, formatBars)),
      perSide('Avg # bars in winning trades', report, (x) => optional(x.avgBarsWin, formatBars)),
      perSide('Avg # bars in losing trades', report, (x) => optional(x.avgBarsLoss, formatBars)),
    ],
  };
  return [returns, trades];
}
