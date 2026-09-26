import { useMemo } from 'react';
import type { CurvePoint } from '../../pine/tester';
import { formatMetric, metricTone, type Curve, type ReportResult } from '../../python/results';
import { EquityChart } from '../pine/EquityChart';
import { ResultTable } from './ResultTable';

interface Props {
  report: ReportResult;
  onOpenSymbol: (symbol: string) => void;
  onAddToWatchlist?: (symbols: string[]) => void;
}

const points = (curve: Curve | null): CurvePoint[] => (curve ? curve.t.map((time, i) => ({ time, value: curve.v[i] })) : []);

/** A backtest a script showed: its figures, the equity curve (the Strategy Tester's own chart)
 *  and the trades. */
export function ResultReport({ report, onOpenSymbol, onAddToWatchlist }: Props) {
  const equity = useMemo(() => points(report.equity), [report.equity]);
  const benchmark = useMemo(() => points(report.benchmark), [report.benchmark]);
  const baseline = report.initialCapital ?? equity[0]?.value ?? 0;

  return (
    <div className="python-report">
      {report.metrics.length > 0 && (
        <div className="python-kpis">
          {report.metrics.map((metric, i) => (
            <div key={i} className="python-kpi">
              <span className="python-kpi-label">{metric.label}</span>
              <span className={`python-kpi-value ${metricTone(metric)}`}>{formatMetric(metric)}</span>
            </div>
          ))}
        </div>
      )}

      {equity.length >= 2 && (
        <EquityChart equity={equity} buyHold={benchmark} initialCapital={baseline} benchmarkLabel="Benchmark" />
      )}

      {report.trades && report.trades.rows.length > 0 && (
        <ResultTable table={report.trades} onOpenSymbol={onOpenSymbol} onAddToWatchlist={onAddToWatchlist} />
      )}
    </div>
  );
}
