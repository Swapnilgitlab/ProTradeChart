import { useState } from 'react';
import { formatMeasure, type MeasureUnit } from '../../studies/measures';
import { offsetLabel } from '../../studies/metrics';
import type { MeasureResult, PathBand } from '../../studies/result';

/** Small SVG charts for the Study Results page. They take the theme's colours through CSS
 *  (studies.css) and draw only numbers the engine produced; labels are text nodes, never markup. */

const W = 640;

interface HistogramProps {
  edges: number[];
  events: number[];
  control: number[];
  unit: MeasureUnit;
  /** Shown beside the control bars' key; null hides them. */
  controlLabel: string | null;
  /** What the event bars are called: "Events", or "Reached the outcome". */
  eventLabel?: string;
  /** Events with no number to bin (a condition that never held), said beside the chart. */
  never?: number;
}

/** Events and the comparison group on shared bins, each as a share of its own group so groups of
 *  different sizes compare. */
export function Histogram({ edges, events, control, unit, controlLabel, eventLabel = 'Events', never = 0 }: HistogramProps) {
  const formatValue = formatMeasure;
  const [hover, setHover] = useState<number | null>(null);
  const H = 180;
  const PAD = { l: 8, r: 8, t: 10, b: 26 };
  const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0) || 1;
  const ev = events.map((c) => c / total(events));
  const showControl = controlLabel !== null && control.some((c) => c > 0);
  const cv = control.map((c) => c / total(control));
  const peak = Math.max(...ev, ...(showControl ? cv : []), 1e-9);
  const bins = events.length;
  const bw = (W - PAD.l - PAD.r) / bins;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / peak);
  const ticks = [0, Math.floor(bins / 2), bins];
  return (
    <div className="study-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Distribution" onMouseLeave={() => setHover(null)}>
        {ev.map((v, i) => (
          <rect
            key={`e${i}`}
            className="study-bar"
            x={PAD.l + i * bw + 1}
            y={y(v)}
            width={Math.max(bw * (showControl ? 0.5 : 1) - 2, 1)}
            height={H - PAD.b - y(v)}
            onMouseEnter={() => setHover(i)}
          />
        ))}
        {showControl &&
          cv.map((v, i) => (
            <rect
              key={`c${i}`}
              className="study-bar control"
              x={PAD.l + i * bw + bw * 0.5}
              y={y(v)}
              width={Math.max(bw * 0.5 - 1, 1)}
              height={H - PAD.b - y(v)}
              onMouseEnter={() => setHover(i)}
            />
          ))}
        <line className="study-axis" x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} />
        {ticks.map((t) => (
          <text key={t} className="study-tick" x={PAD.l + t * bw} y={H - 8} textAnchor={t === 0 ? 'start' : t === bins ? 'end' : 'middle'}>
            {formatValue(edges[t], unit)}
          </text>
        ))}
      </svg>
      <div className="study-chart-key small muted">
        <span className="study-key events" /> {eventLabel}
        {showControl && (
          <>
            <span className="study-key control" /> {controlLabel}
          </>
        )}
        {never > 0 && <span> · {never} never (not shown)</span>}
        {hover !== null && (
          <span className="study-chart-hover">
            {formatValue(edges[hover], unit)} to {formatValue(edges[hover + 1], unit)}: {events[hover]} event{events[hover] === 1 ? '' : 's'}
            {showControl && `, ${control[hover]} ${controlLabel?.toLowerCase()}`}
          </span>
        )}
      </div>
    </div>
  );
}

interface TimelineProps {
  timeline: NonNullable<MeasureResult['timeline']>;
  eventLabel: string;
  controlLabel: string | null;
}

/** Day by day across a condition measure's window: the share of events on which its conditions held
 *  (and of the comparison group, dashed). How the share of doublers sitting just above their 21 EMA
 *  rose into the event, say. */
export function TimelineChart({ timeline, eventLabel, controlLabel }: TimelineProps) {
  const [hover, setHover] = useState<number | null>(null);
  const H = 200;
  const PAD = { l: 40, r: 10, t: 10, b: 24 };
  const { offsets } = timeline;
  const first = offsets[0];
  const last = offsets[offsets.length - 1];
  const x = (o: number) => PAD.l + ((o - first) / Math.max(last - first, 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v);
  const line = (series: (number | null)[]) =>
    offsets
      .map((o, i) => (series[i] === null ? null : `${x(o).toFixed(1)},${y(series[i] as number).toFixed(1)}`))
      .filter(Boolean)
      .join(' ');
  if (timeline.events.filter((v) => v !== null).length < 2) {
    return <div className="study-empty small muted">Not enough history around the events to draw this day by day.</div>;
  }
  const control = controlLabel ? timeline.control : null;
  const i = hover;
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
  return (
    <div className="study-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Share of events on which the conditions held, day by day"
        onMouseMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const o = first + ((((e.clientX - box.left) / box.width) * W - PAD.l) / (W - PAD.l - PAD.r)) * (last - first);
          let best = 0;
          offsets.forEach((p, k) => {
            if (Math.abs(p - o) < Math.abs(offsets[best] - o)) best = k;
          });
          setHover(best);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line className="study-grid-line" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
            <text className="study-tick" x={PAD.l - 4} y={y(v) + 3} textAnchor="end">
              {Math.round(v * 100)}%
            </text>
          </g>
        ))}
        {control && <polyline className="study-line control" points={line(control)} />}
        <polyline className="study-line" points={line(timeline.events)} />
        {first <= 0 && last >= 0 && <line className="study-event-line" x1={x(0)} x2={x(0)} y1={PAD.t} y2={H - PAD.b} />}
        {[...new Set([first, ...(first <= 0 && last >= 0 ? [0] : []), last])].map((o) => (
          <text key={o} className="study-tick" x={x(o)} y={H - 6} textAnchor={o === first ? 'start' : o === last ? 'end' : 'middle'}>
            {offsetLabel(o)}
          </text>
        ))}
        {i !== null && <line className="study-hover-line" x1={x(offsets[i])} x2={x(offsets[i])} y1={PAD.t} y2={H - PAD.b} />}
      </svg>
      <div className="study-chart-key small muted">
        <span className="study-key events" /> {eventLabel}
        {control && (
          <>
            <span className="study-key control" /> {controlLabel}
          </>
        )}
        {i !== null && (
          <span className="study-chart-hover">
            {offsetLabel(offsets[i])} ({offsets[i]} bars): {pct(timeline.events[i])} of {timeline.count[i]} events
            {control && `; ${pct(control[i])} of ${controlLabel?.toLowerCase()}`}
          </span>
        )}
      </div>
    </div>
  );
}

interface PathProps {
  path: PathBand;
  control: PathBand | null;
  controlLabel: string;
}

/** The typical price path around the event: the event's close is 1, the line is the median across
 *  events and the band the middle half. The comparison group's median is dashed. */
export function PathChart({ path, control, controlLabel }: PathProps) {
  const [hover, setHover] = useState<number | null>(null);
  const H = 220;
  const PAD = { l: 44, r: 10, t: 10, b: 24 };
  const first = path.offsets[0];
  const last = path.offsets[path.offsets.length - 1];
  const values = [...path.p25, ...path.p75, ...path.median, ...(control?.median ?? [])].filter((v): v is number => v !== null);
  if (values.length < 2) return <div className="study-empty small muted">Not enough history around the events to draw a path.</div>;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const x = (o: number) => PAD.l + ((o - first) / Math.max(last - first, 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - lo) / Math.max(hi - lo, 1e-9));
  const line = (band: PathBand, series: (number | null)[]) =>
    band.offsets
      .map((o, i) => (series[i] === null ? null : `${x(o).toFixed(1)},${y(series[i] as number).toFixed(1)}`))
      .filter(Boolean)
      .join(' ');
  const area = () => {
    const top = path.offsets.map((o, i) => (path.p75[i] === null ? null : `${x(o).toFixed(1)},${y(path.p75[i] as number).toFixed(1)}`)).filter(Boolean);
    const bottom = path.offsets
      .map((o, i) => (path.p25[i] === null ? null : `${x(o).toFixed(1)},${y(path.p25[i] as number).toFixed(1)}`))
      .filter(Boolean)
      .reverse();
    return [...top, ...bottom].join(' ');
  };
  const i = hover;
  return (
    <div className="study-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Price path around the event"
        onMouseMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const o = first + ((((e.clientX - box.left) / box.width) * W - PAD.l) / (W - PAD.l - PAD.r)) * (last - first);
          let best = 0;
          path.offsets.forEach((p, k) => {
            if (Math.abs(p - o) < Math.abs(path.offsets[best] - o)) best = k;
          });
          setHover(best);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <polygon className="study-band" points={area()} />
        {control && <polyline className="study-line control" points={line(control, control.median)} />}
        <polyline className="study-line" points={line(path, path.median)} />
        <line className="study-event-line" x1={x(0)} x2={x(0)} y1={PAD.t} y2={H - PAD.b} />
        {[lo, 1, hi].filter((v) => v >= lo && v <= hi).map((v) => (
          <text key={v} className="study-tick" x={PAD.l - 4} y={y(v) + 3} textAnchor="end">
            {v.toFixed(2)}×
          </text>
        ))}
        {[first, 0, last].map((o) => (
          <text key={o} className="study-tick" x={x(o)} y={H - 6} textAnchor={o === first ? 'start' : o === last ? 'end' : 'middle'}>
            {offsetLabel(o)}
          </text>
        ))}
        {i !== null && <line className="study-hover-line" x1={x(path.offsets[i])} x2={x(path.offsets[i])} y1={PAD.t} y2={H - PAD.b} />}
      </svg>
      <div className="study-chart-key small muted">
        <span className="study-key events" /> Median of events (band: middle half)
        {control && (
          <>
            <span className="study-key control" /> {controlLabel}
          </>
        )}
        {i !== null && (
          <span className="study-chart-hover">
            {offsetLabel(path.offsets[i])} ({path.offsets[i]} bars): {path.median[i]?.toFixed(3) ?? '—'}× the event’s close, {path.count[i]} events
          </span>
        )}
      </div>
    </div>
  );
}
