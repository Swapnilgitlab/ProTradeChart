import { useMemo, useState } from 'react';
import { CircleAlert, Code } from 'lucide-react';
import { displayTicker } from '../../lib/symbols';
import type { TradeRow } from '../../pine/tester';
import { EquityChart } from './EquityChart';
import { formatMoney, formatPct, formatQty, formatRatio, formatSignedMoney, formatWhen, pnlClass } from './format';
import { performanceSections } from './performance';
import type { StrategyEntry } from './useStrategyReports';

type View = 'overview' | 'performance' | 'trades';

const VIEWS: { id: View; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'performance', label: 'Performance summary' },
  { id: 'trades', label: 'List of trades' },
];

interface Props {
  entries: StrategyEntry[];
  onOpenEditor: () => void;
}

export function StrategyTester({ entries, onOpenEditor }: Props) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [view, setView] = useState<View>('overview');

  const entry = entries.find((e) => e.key === selectedKey) ?? entries[0];

  if (!entry) {
    return (
      <div className="pine-empty">
        <div className="pine-empty-title">No strategy on the chart yet</div>
        <p className="secondary">
          Write a <code>strategy()</code> script in the Script Editor and add it to the chart. Its trades, equity curve and
          performance will appear here.
        </p>
        <button type="button" className="btn btn-primary" onClick={onOpenEditor}>
          <Code size={14} />
          Open Script Editor
        </button>
      </div>
    );
  }

  return (
    <div className="pine-tester">
      <div className="pine-tester-header">
        <select className="pine-select" value={entry.key} onChange={(e) => setSelectedKey(e.currentTarget.value)} aria-label="Strategy">
          {entries.map((e) => (
            <option key={e.key} value={e.key}>
              {e.title} · {displayTicker(e.symbol)}, {e.timeframe}
            </option>
          ))}
        </select>
        <div className="pine-tabs" role="tablist" aria-label="Report">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" role="tab" aria-selected={view === v.id} className={`pine-tab${view === v.id ? ' active' : ''}`} onClick={() => setView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
        <span className="pine-approx small muted" title="The backtest runs on PineTS's broker emulator, which differs from TradingView's in some order-handling details.">
          Approximate — may differ from TradingView
        </span>
      </div>

      <RangeNote entry={entry} />

      {entry.report.warnings.map((w) => (
        <div key={w} className="pine-warning" role="alert">
          <CircleAlert size={14} />
          <span>{w}</span>
        </div>
      ))}

      <div className="pine-tester-body">
        {view === 'overview' && <Overview entry={entry} />}
        {view === 'performance' && <Performance entry={entry} />}
        {view === 'trades' && <Trades entry={entry} />}
      </div>
    </div>
  );
}

/** What the backtest covers. It runs on the bars the chart has loaded, so more history
 *  means scrolling the chart back (or raising Bars in the chart settings). */
function RangeNote({ entry }: { entry: StrategyEntry }) {
  const { equity } = entry.report;
  if (equity.length === 0) return null;
  return (
    <div className="pine-range small muted">
      Tested on {equity.length.toLocaleString('en-US')} bars, {formatWhen(equity[0].time)} to {formatWhen(equity[equity.length - 1].time)}. Scroll the chart back to load
      more history and test over a longer period.
    </div>
  );
}

function Kpi({ label, value, sub, tone = '' }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="pine-kpi">
      <div className="pine-kpi-label">{label}</div>
      <div className={`pine-kpi-value mono ${tone}`}>{value}</div>
      {sub && <div className={`pine-kpi-sub mono ${tone}`}>{sub}</div>}
    </div>
  );
}

function Overview({ entry }: { entry: StrategyEntry }) {
  const { report, currency } = entry;
  const s = report.summary;
  const closed = s.closedTrades;
  return (
    <div className="pine-overview">
      <div className="pine-kpis">
        <Kpi label="Total P&L" value={formatSignedMoney(s.totalPnl, currency)} sub={formatPct(s.totalPnlPct, true)} tone={pnlClass(s.totalPnl)} />
        <Kpi label="Max equity drawdown" value={formatMoney(-s.maxDrawdown, currency)} sub={formatPct(s.maxDrawdownPct)} tone={s.maxDrawdown > 0 ? 'neg' : ''} />
        <Kpi label="Total trades" value={String(closed + s.openTrades)} sub={s.openTrades > 0 ? `${s.openTrades} open` : undefined} />
        <Kpi label="Profitable trades" value={s.percentProfitable === null ? '—' : formatPct(s.percentProfitable)} sub={closed > 0 ? `${s.winning} / ${closed}` : undefined} />
        <Kpi label="Profit factor" value={s.profitFactor === null ? '—' : formatRatio(s.profitFactor)} />
      </div>
      <EquityChart equity={report.equity} buyHold={report.buyHold} initialCapital={s.initialCapital} currency={currency} />
    </div>
  );
}

function Performance({ entry }: { entry: StrategyEntry }) {
  const sections = useMemo(() => performanceSections(entry.report, entry.currency), [entry.report, entry.currency]);
  return (
    <table className="pine-table pine-performance">
      <thead>
        <tr>
          <th scope="col">Metric</th>
          <th scope="col" className="num">All</th>
          <th scope="col" className="num">Long</th>
          <th scope="col" className="num">Short</th>
        </tr>
      </thead>
      {sections.map((section) => (
        <tbody key={section.title}>
          <tr className="pine-table-section">
            <th colSpan={4}>{section.title}</th>
          </tr>
          {section.rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              {[row.all, row.long, row.short].map((cell, i) => (
                <td key={i} className={`num mono ${cell.tone}`}>
                  {cell.text}
                  {cell.sub && <div className="pine-cell-sub">{cell.sub}</div>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}

/** TradingView's list: every trade is an Entry line and, once closed, an Exit line — newest first. */
function Trades({ entry }: { entry: StrategyEntry }) {
  const rows = useMemo(() => [...entry.report.rows].reverse(), [entry.report.rows]);
  if (rows.length === 0) return <div className="pine-chart-empty">This strategy hasn't made any trades on the loaded bars.</div>;
  return (
    <table className="pine-table pine-trades">
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">Type</th>
          <th scope="col">Signal</th>
          <th scope="col">Date / time</th>
          <th scope="col" className="num">Price</th>
          <th scope="col" className="num">Size</th>
          <th scope="col" className="num">Net P&amp;L</th>
          <th scope="col" className="num">Run-up</th>
          <th scope="col" className="num">Drawdown</th>
          <th scope="col" className="num">Cumulative P&amp;L</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <TradeLines key={r.n} row={r} />
        ))}
      </tbody>
    </table>
  );
}

function TradeLines({ row: r }: { row: TradeRow }) {
  const side = r.side === 'long' ? 'long' : 'short';
  return (
    <>
      {!r.open && r.exitTime !== null && r.exitPrice !== null && (
        <tr className="pine-trade-exit">
          <td rowSpan={2} className="pine-trade-n mono">{r.n}</td>
          <td>Exit {side}{r.marginCall && <span className="pine-badge neg">Margin call</span>}</td>
          <td>{r.exitSignal}</td>
          <td className="mono">{formatWhen(r.exitTime)}</td>
          <td className="num mono">{formatMoney(r.exitPrice)}</td>
          <td className="num mono">{formatQty(r.qty)}</td>
          <td className={`num mono ${pnlClass(r.pnl)}`}>
            {formatSignedMoney(r.pnl)}
            <div className="pine-cell-sub">{formatPct(r.pnlPct, true)}</div>
          </td>
          <td className="num mono">{formatMoney(r.runup)}</td>
          <td className="num mono">{formatMoney(-r.drawdown)}</td>
          <td className={`num mono ${pnlClass(r.cumPnl)}`}>{formatSignedMoney(r.cumPnl)}</td>
        </tr>
      )}
      <tr className="pine-trade-entry">
        {(r.open || r.exitTime === null) && <td className="pine-trade-n mono">{r.n}</td>}
        <td>
          Entry {side}
          {r.open && <span className="pine-badge">Open</span>}
        </td>
        <td>{r.entrySignal}</td>
        <td className="mono">{formatWhen(r.entryTime)}</td>
        <td className="num mono">{formatMoney(r.entryPrice)}</td>
        <td className="num mono">{formatQty(r.qty)}</td>
        {r.open ? (
          <>
            <td className={`num mono ${pnlClass(r.pnl)}`}>
              {formatSignedMoney(r.pnl)}
              <div className="pine-cell-sub">{formatPct(r.pnlPct, true)} unrealised</div>
            </td>
            <td className="num mono">{formatMoney(r.runup)}</td>
            <td className="num mono">{formatMoney(-r.drawdown)}</td>
            <td className="num muted">—</td>
          </>
        ) : (
          <td colSpan={4} />
        )}
      </tr>
    </>
  );
}
