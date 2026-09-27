import { useState } from 'react';
import { headlineMeasures, measureUnit, STAT_LABEL, windowPhrase } from '../../studies/measures';
import type { StudyResultData } from '../../studies/result';
import { Histogram, TimelineChart } from './charts';

interface Props {
  result: StudyResultData;
  eventLabel: string;
  controlLabel: string | null;
}

type View = 'spread' | 'daily';

/** One chart for the measures: how a measure's values spread across the stocks, or, for a measure
 *  of days a condition held, the share of stocks where it held on each day of the window. */
export function MeasureChart({ result, eventLabel, controlLabel }: Props) {
  const measures = result.measures.filter((m) => result.spec.measures[m.index]);
  const lead = headlineMeasures(measures.map((m) => ({ m, headline: result.spec.measures[m.index].headline })))[0]?.m;
  const [index, setIndex] = useState(lead?.index ?? 0);
  const [view, setView] = useState<View>('spread');
  const m = measures.find((x) => x.index === index) ?? measures[0];
  if (!m) return null;
  const spec = result.spec.measures[m.index];
  const shown: View = view === 'daily' && m.timeline ? 'daily' : 'spread';

  return (
    <section className="study-block">
      <div className="study-block-head">
        <h3>{shown === 'daily' ? 'Day by day' : 'Across the stocks'}</h3>
        {measures.length > 1 && (
          <select className="python-input" aria-label="Measure" value={m.index} onChange={(e) => setIndex(Number(e.currentTarget.value))}>
            {measures.map((x) => (
              <option key={x.index} value={x.index}>
                {x.label} · {STAT_LABEL[x.stat].toLowerCase()}
              </option>
            ))}
          </select>
        )}
        {m.timeline && (
          <div className="study-toggle" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={shown === 'spread'} className={shown === 'spread' ? 'active' : undefined} onClick={() => setView('spread')}>
              Spread across stocks
            </button>
            <button type="button" role="tab" aria-selected={shown === 'daily'} className={shown === 'daily' ? 'active' : undefined} onClick={() => setView('daily')}>
              Day by day
            </button>
          </div>
        )}
      </div>
      <p className="muted small">
        {shown === 'daily'
          ? `On each day ${windowPhrase(spec.window)}, the share of events on which “${m.label}” held.`
          : `${STAT_LABEL[m.stat]} ${windowPhrase(spec.window)}, one value per event: how they spread.`}
      </p>
      {shown === 'daily' && m.timeline ? (
        <TimelineChart timeline={m.timeline} eventLabel={eventLabel} controlLabel={controlLabel} />
      ) : m.histogram ? (
        <Histogram
          edges={m.histogram.edges}
          events={m.histogram.events}
          control={m.histogram.control}
          unit={measureUnit(spec)}
          controlLabel={controlLabel}
          eventLabel={eventLabel}
          never={m.events.status.never}
        />
      ) : (
        <div className="study-empty small muted">No event could be measured for this.</div>
      )}
    </section>
  );
}
