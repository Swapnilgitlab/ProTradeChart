import { Trash2 } from 'lucide-react';
import type { PythonResult } from '../../python/results';
import { ResultReport } from './ResultReport';
import { ResultTable } from './ResultTable';

interface Props {
  results: readonly PythonResult[];
  /** Which result is showing; the newest when it isn't one of these. */
  selectedId: number | null;
  onSelect: (id: number) => void;
  onClear: () => void;
  onOpenSymbol: (symbol: string) => void;
  onAddToWatchlist: (symbols: string[]) => void;
}

const label = (result: PythonResult, index: number) =>
  result.title ?? `${result.kind === 'report' ? 'Report' : result.kind === 'figure' ? 'Figure' : 'Table'} ${index + 1}`;

/** What the running script showed: one tab per result, newest last. */
export function ResultsPane({ results, selectedId, onSelect, onClear, onOpenSymbol, onAddToWatchlist }: Props) {
  if (results.length === 0) {
    return (
      <div className="python-empty">
        <p>Nothing shown yet.</p>
        <p className="muted small">
          Call <code>pt.show(frame)</code> for a table, <code>pt.report(...)</code> for a backtest, or{' '}
          <code>pt.plot()</code> for a matplotlib figure.
        </p>
      </div>
    );
  }
  const showing = results.find((r) => r.id === selectedId) ?? results[results.length - 1];

  return (
    <div className="python-results">
      <div className="python-results-bar">
        <div className="python-result-tabs" role="tablist">
          {results.map((result, i) => (
            <button
              key={result.id}
              type="button"
              role="tab"
              aria-selected={result.id === showing.id}
              className={`python-result-tab${result.id === showing.id ? ' active' : ''}`}
              onClick={() => onSelect(result.id)}
              title={label(result, i)}
            >
              {label(result, i)}
            </button>
          ))}
        </div>
        <button type="button" className="icon-button" aria-label="Clear results" title="Clear results" onClick={onClear}>
          <Trash2 size={13} />
        </button>
      </div>

      <div className="python-result-body">
        {showing.kind === 'table' && <ResultTable table={showing} onOpenSymbol={onOpenSymbol} onAddToWatchlist={onAddToWatchlist} />}
        {showing.kind === 'report' && <ResultReport report={showing} onOpenSymbol={onOpenSymbol} onAddToWatchlist={onAddToWatchlist} />}
        {showing.kind === 'figure' && (
          <div className="python-figure">
            {/* A PNG the script drew; `results.ts` has checked it really is one. */}
            <img src={showing.src} alt={showing.title ?? 'Figure from a script'} />
          </div>
        )}
      </div>
    </div>
  );
}
