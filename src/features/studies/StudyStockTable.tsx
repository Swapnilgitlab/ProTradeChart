import { useMemo, useState } from 'react';
import { LineChart, ListPlus } from 'lucide-react';
import type { StudyEvent } from '../../chart/studyEvent';
import { displayTicker } from '../../lib/symbols';
import type { Cell } from '../../python/results';
import { formatMeasure, STAT_LABEL } from '../../studies/measures';
import type { StudyResultData } from '../../studies/result';
import { measureColumns, sortRows, STATUS_WORD, type TableColumn } from '../../studies/views';

interface Props {
  result: StudyResultData;
  onOpenEvent: (event: StudyEvent) => void;
  onAddToWatchlist: (symbols: string[]) => void;
}

/** One row per event with what each measure came to for it — the per-stock answer — or why it has
 *  no value ("too recent", "never"). Sortable; a row opens the stock's chart at the event. */
export function StudyStockTable({ result, onOpenEvent, onAddToWatchlist }: Props) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const cols = result.events.columns;
  const at = (key: string) => cols.indexOf(key);
  const base: TableColumn[] = [
    { key: 'symbol', index: at('symbol'), metric: null, unit: 'symbol' },
    { key: 'name', index: at('name'), metric: null, unit: 'text' },
    { key: 'event_date', index: at('event_date'), metric: null, unit: 'date' },
  ].filter((c) => c.index >= 0) as TableColumn[];
  const columns = [...base, ...measureColumns(result)];
  const rows = useMemo(() => sortRows(result, sort), [result, sort]);
  const symbols = useMemo(() => [...new Set(result.events.rows.map((r) => r[at('symbol')]).filter((s): s is string => typeof s === 'string'))], [result]);

  const title = (c: TableColumn): string => {
    if (c.key === 'symbol') return 'Symbol';
    if (c.key === 'name') return 'Company';
    if (c.key === 'event_date') return 'Event date';
    const k = Number(c.key.split('_')[1]);
    const m = result.spec.measures[k];
    if (!m) return c.key;
    return c.measure ? `${m.label} · ${STAT_LABEL[m.stat].toLowerCase()}` : `${m.label}: began`;
  };
  const text = (row: Cell[], c: TableColumn): string => {
    const v = row[c.index];
    if (v === null) {
      const status = c.measure ? row[c.measure.statusIndex] : null;
      return typeof status === 'string' && STATUS_WORD[status] ? STATUS_WORD[status] : '—';
    }
    if (c.unit === 'symbol') return typeof v === 'string' ? displayTicker(v) : String(v);
    if (typeof v !== 'number' || c.unit === 'date' || c.unit === 'text') return String(v);
    const capped = c.measure && row[c.measure.statusIndex] === 'capped';
    return `${formatMeasure(v, c.unit)}${capped ? '+' : ''}`;
  };
  const open = (row: Cell[]) => {
    const symbol = row[at('symbol')];
    const date = row[at('event_date')];
    if (typeof symbol === 'string' && typeof date === 'string') onOpenEvent({ symbol, date, label: result.spec.event.label });
  };

  return (
    <section className="study-block">
      <div className="study-block-head">
        <h3>Stock by stock</h3>
        <span className="muted small">
          {result.events.total.toLocaleString()} events{rows.length < result.events.total && `, the first ${rows.length.toLocaleString()} listed`}
        </span>
        {symbols.length > 0 && (
          <button type="button" className="btn btn-tiny" onClick={() => onAddToWatchlist(symbols)}>
            <ListPlus size={13} />
            Add {symbols.length} to a watchlist
          </button>
        )}
      </div>
      <div className="python-table-scroll study-table-scroll">
        <table className="python-table study-table">
          <thead>
            <tr>
              <th />
              {columns.map((c) => (
                <th key={c.key} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" onClick={() => setSort((s) => (s?.key === c.key ? (s.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 }))}>
                    {title(c)}
                    {sort?.key === c.key && <span aria-hidden="true">{sort.dir === 1 ? ' ▲' : ' ▼'}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ row, i }) => (
              <tr key={i} onClick={() => open(row)} title="Open the chart at this event">
                <td>
                  <LineChart size={13} className="muted" aria-hidden="true" />
                </td>
                {columns.map((c) => (
                  <td key={c.key} className={c.unit === 'text' || c.unit === 'symbol' || c.unit === 'date' ? undefined : 'numeric'}>
                    {text(row, c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">A value ending in + ran to the limit of its search, so it is a lower bound. Click a row to open its chart at the event.</p>
    </section>
  );
}
