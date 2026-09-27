import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { StudyEvent } from '../../chart/studyEvent';
import { answer, groupNames } from '../../studies/answer';
import { formatRupees } from '../../studies/metrics';
import { endpointRange } from '../../studies/spec';
import type { StudyResultData } from '../../studies/result';
import { describeCondition } from '../../studies/spec';
import { headline } from '../../studies/views';
import { MeasureChart } from './MeasureChart';
import { StudyAnswer } from './StudyAnswer';
import { StudyDetails } from './StudyDetails';
import { StudyStockTable } from './StudyStockTable';

interface Props {
  result: StudyResultData;
  onOpenEvent: (event: StudyEvent) => void;
  onAddToWatchlist: (symbols: string[]) => void;
  /** Opens the builder on this Study (from the "add a measure" suggestion). */
  onEditStudy?: () => void;
}

/** The Study Results page, answer first: the question, the plain answer from the headline measures,
 *  one chart, the stocks one by one, and the limits in a line; then every table the result holds,
 *  folded under Details. Everything drawn is text or SVG built from numbers. */
export function StudyResults({ result, onOpenEvent, onAddToWatchlist, onEditStudy }: Props) {
  const { spec } = result;
  const found = useMemo(() => answer(result), [result]);
  const { group, comparison } = groupNames(result);
  const hasMeasures = result.measures.length > 0;
  // A before-window longer than the cooldown can reach into another event's run-up on a control date.
  const overlap =
    result.summary.control_kind === 'random' &&
    spec.measures.some((m) => -Math.min(endpointRange(m.window.start)[0], endpointRange(m.window.end)[0]) > spec.event.cooldown_days);

  return (
    <div className="study-results">
      <header className="study-results-header">
        <div>
          <h2>{spec.name}</h2>
          {(spec.question || spec.description) && <p className="study-question">{spec.question || spec.description}</p>}
          <div className="study-headline">{headline(result)}</div>
          <div className="muted small">
            {spec.event.conditions.map(describeCondition).join(' and ')} ·{' '}
            {spec.universe.source === 'instruments' ? spec.universe.exchanges.join(' + ') : spec.universe.source === 'watchlist' ? `Watchlist “${spec.universe.watchlist}”` : `${spec.universe.symbols.length} symbols`}
            {spec.universe.min_avg_traded_value !== null && ` · Avg traded value ≥ ${formatRupees(spec.universe.min_avg_traded_value)}/day`}
          </div>
        </div>
      </header>

      <StudyAnswer answer={found} onAddMeasure={onEditStudy} />

      {hasMeasures && <MeasureChart result={result} eventLabel={group} controlLabel={comparison} />}
      {hasMeasures && <StudyStockTable result={result} onOpenEvent={onOpenEvent} onAddToWatchlist={onAddToWatchlist} />}

      <p className="study-caveat-line small muted" role="note">
        <AlertTriangle size={13} aria-hidden="true" />
        <span>
          Historical association, not causation. Stocks delisted before today are missing, which can flatter the results.
          {overlap && ' A window reaching back further than the cooldown can include another event’s run-up on a comparison date.'}
          {result.warnings.length > 0 && ' More in Details.'}
        </span>
      </p>

      <details className="study-details" open={!hasMeasures}>
        <summary>Details: every table in the result</summary>
        <StudyDetails result={result} onOpenEvent={onOpenEvent} onAddToWatchlist={onAddToWatchlist} />
      </details>
    </div>
  );
}
