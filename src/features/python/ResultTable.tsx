import { useMemo, useState } from 'react';
import { ListPlus } from 'lucide-react';
import { displayTicker } from '../../lib/symbols';
import { formatCell, sortRows, symbolsOf, type TableResult } from '../../python/results';

interface Props {
  table: TableResult;
  /** Opens a symbol on the active chart. */
  onOpenSymbol: (symbol: string) => void;
  /** Adds every symbol in the table to a watchlist. */
  onAddToWatchlist?: (symbols: string[]) => void;
}

type Sort = { column: number; direction: 'asc' | 'desc' } | null;

/** A table a script showed: sortable, with symbols that open their chart. */
export function ResultTable({ table, onOpenSymbol, onAddToWatchlist }: Props) {
  const [sort, setSort] = useState<Sort>(null);
  const rows = useMemo(() => (sort ? sortRows(table.rows, sort.column, sort.direction) : table.rows), [table.rows, sort]);
  const symbols = useMemo(() => symbolsOf(table), [table]);

  const toggle = (column: number) =>
    setSort((s) => (s?.column === column ? (s.direction === 'asc' ? { column, direction: 'desc' } : null) : { column, direction: 'asc' }));

  return (
    <div className="python-result-table">
      <div className="python-result-bar">
        <span className="muted small">
          {table.totalRows.toLocaleString()} {table.totalRows === 1 ? 'row' : 'rows'}
          {table.rows.length < table.totalRows && ` · showing the first ${table.rows.length.toLocaleString()}`}
        </span>
        {symbols.length > 0 && onAddToWatchlist && (
          <button type="button" className="btn btn-tiny" onClick={() => onAddToWatchlist(symbols)}>
            <ListPlus size={13} />
            Add {symbols.length} to a watchlist
          </button>
        )}
      </div>
      <div className="python-table-scroll">
        <table className="python-table">
          <thead>
            <tr>
              {table.columns.map((name, i) => (
                <th key={i} aria-sort={sort?.column === i ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" onClick={() => toggle(i)} title={`Sort by ${name}`}>
                    {name}
                    {sort?.column === i && <span aria-hidden="true">{sort.direction === 'asc' ? ' ▲' : ' ▼'}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((value, c) => {
                  const isSymbol = c === table.symbolColumn && typeof value === 'string' && value.includes(':');
                  return (
                    <td key={c} className={typeof value === 'number' ? 'numeric' : undefined}>
                      {isSymbol ? (
                        <button type="button" className="python-symbol" onClick={() => onOpenSymbol(value as string)} title={`Open ${value}`}>
                          {displayTicker(value as string)}
                        </button>
                      ) : (
                        formatCell(value, table.digits)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
