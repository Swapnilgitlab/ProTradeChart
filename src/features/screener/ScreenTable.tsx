import { useMemo, useState } from 'react';
import { CandlestickChart, Download, ListPlus, Table2 } from 'lucide-react';
import { displayTicker } from '../../lib/symbols';
import { sortScreenRows, type ScreenResult, type SortKey } from '../../screener/result';
import { featureLabel, featureUnit, formatValue } from '../../studies/metrics';
import { ScreenCharts } from './ScreenCharts';
import { ScreenFlag } from './ScreenFlag';
import { useSymbolFlags } from './useSymbolFlags';

interface Props {
  result: ScreenResult;
  onOpenSymbol: (symbol: string) => void;
  onAddToWatchlist: (symbols: string[]) => void;
  onExport: (rows: ScreenResult['rows']) => void;
  /** Told when the user switches between the table and the charts. */
  onViewChange?: (view: 'table' | 'charts') => void;
}

/** A change, a return or a distance reads best signed and coloured. */
const SIGNED = /^(return|dist_|gain_from_low|slope_|rs_|drawdown|max_drawdown|macd)/;

/** The matches, one row per stock: sortable by any column, and a row opens its chart. Everything is
 *  drawn as text. **Charts** shows the same matches, in the table's order, as pages of candlestick
 *  charts (`ScreenCharts`). */
export function ScreenTable({ result, onOpenSymbol, onAddToWatchlist, onExport, onViewChange }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean } | null>(null);
  const [view, setViewState] = useState<'table' | 'charts'>('table');
  const setView = (next: 'table' | 'charts') => {
    setViewState(next);
    onViewChange?.(next);
  };
  const rows = useMemo(() => sortScreenRows(result.rows, sort), [result, sort]);
  const ordered = useMemo(() => rows.map((r) => r.symbol), [rows]);
  const names = useMemo(() => new Map(rows.map((r) => [r.symbol, r.name])), [rows]);
  const symbols = useMemo(() => result.rows.map((r) => r.symbol), [result]);
  const { flags, setFlag } = useSymbolFlags(symbols);
  // A number column sorts high-to-low first (what a screen is usually after), text A-to-Z; the second
  // press reverses it and the third goes back to the screen's own order.
  const toggle = (key: SortKey) =>
    setSort((s) => {
      const first = typeof key === 'number';
      if (s?.key !== key) return { key, descending: first };
      return s.descending === first ? { key, descending: !first } : null;
    });
  const ariaSort = (key: SortKey) => (sort?.key === key ? (sort.descending ? 'descending' : 'ascending') : 'none');
  const arrow = (key: SortKey) => sort?.key === key && <span aria-hidden="true">{sort.descending ? ' ▼' : ' ▲'}</span>;
  const { meta } = result;
  const differentDates = rows.some((r) => r.date !== meta.asOf);

  return (
    <section className="study-block screener-results">
      <div className="study-block-head">
        <h3>
          {meta.matched.toLocaleString()} of {meta.loaded.toLocaleString()} match
        </h3>
        <span className="muted small">
          as of {meta.asOf}
          {rows.length < meta.matched && ` · the first ${rows.length.toLocaleString()} shown`}
        </span>
        <div className="pine-toolbar-spacer" />
        {rows.length > 0 && (
          <span className="screener-chip screener-chip-static" role="group" aria-label="View">
            <button type="button" className={`screener-exchange${view === 'table' ? ' on' : ''}`} aria-pressed={view === 'table'} onClick={() => setView('table')}>
              <Table2 size={12} aria-hidden="true" /> Table
            </button>
            <button type="button" className={`screener-exchange${view === 'charts' ? ' on' : ''}`} aria-pressed={view === 'charts'} onClick={() => setView('charts')}>
              <CandlestickChart size={12} aria-hidden="true" /> Charts
            </button>
          </span>
        )}
        {symbols.length > 0 && (
          <>
            <button type="button" className="btn btn-tiny" onClick={() => onAddToWatchlist(symbols)}>
              <ListPlus size={13} />
              Add {symbols.length.toLocaleString()} to a watchlist
            </button>
            <button type="button" className="btn btn-tiny" onClick={() => onExport(rows)} title="Save the table as CSV, in its current order">
              <Download size={13} />
              CSV
            </button>
          </>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="muted small">Nothing in the universe matches every filter on its latest bar.</p>
      ) : view === 'charts' ? (
        <ScreenCharts symbols={ordered} names={names} flags={flags} onFlag={setFlag} onOpenSymbol={onOpenSymbol} />
      ) : (
        <div className="python-table-scroll screener-table-scroll">
          <table className="python-table study-table">
            <thead>
              <tr>
                <th />
                <th aria-sort={ariaSort('symbol')}>
                  <button type="button" onClick={() => toggle('symbol')}>
                    Symbol{arrow('symbol')}
                  </button>
                </th>
                <th aria-sort={ariaSort('name')}>
                  <button type="button" onClick={() => toggle('name')}>
                    Company{arrow('name')}
                  </button>
                </th>
                {differentDates && <th>Last bar</th>}
                {result.columns.map((c, i) => (
                  <th key={c} aria-sort={ariaSort(i)} title={c}>
                    <button type="button" onClick={() => toggle(i)}>
                      {featureLabel(c)}
                      {arrow(i)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol} onClick={() => onOpenSymbol(r.symbol)} title={`Open ${displayTicker(r.symbol)} on the chart`}>
                  <td className="screener-flag-cell">
                    <ScreenFlag symbol={r.symbol} flag={flags[r.symbol] ?? null} onFlag={(flag) => setFlag(r.symbol, flag)} />
                  </td>
                  <td className="screener-symbol">{displayTicker(r.symbol)}</td>
                  <td className="screener-name">{r.name ?? ''}</td>
                  {differentDates && <td className={r.date === meta.asOf ? 'muted' : 'study-warn'}>{r.date}</td>}
                  {r.values.map((v, i) => {
                    const c = result.columns[i];
                    const unit = featureUnit(c);
                    const tone = v !== null && v !== 0 && SIGNED.test(c) ? (v > 0 ? ' study-profit' : ' study-loss') : '';
                    return (
                      <td key={c} className={`numeric${tone}`}>
                        {formatValue(v, unit, unit === 'percent' ? 2 : 1)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
