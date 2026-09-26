import { useMemo, useState } from 'react';
import type { CurvePoint } from '../../pine/tester';
import { downsample, linePath, nearestIndex, valueDomain, yFor } from './chartMath';
import { formatMoney, formatWhen } from './format';

const W = 1000;
const H = 240;
const MAX_POINTS = 700;

interface Props {
  equity: readonly CurvePoint[];
  buyHold: readonly CurvePoint[];
  initialCapital: number;
  currency?: string;
  /** What the second curve is called. A Python report may compare against anything. */
  benchmarkLabel?: string;
}

/** The strategy's equity over time, against buy & hold, drawn as plain SVG so it takes the
 *  theme's colours and needs no charting dependency. The strokes don't scale with the
 *  box, so the lines stay crisp at any panel width. */
export function EquityChart({ equity, buyHold, initialCapital, currency, benchmarkLabel = 'Buy & hold' }: Props) {
  const [showEquity, setShowEquity] = useState(true);
  const [showBuyHold, setShowBuyHold] = useState(true);
  const [hover, setHover] = useState<number | null>(null);

  const eq = useMemo(() => downsample(equity, MAX_POINTS), [equity]);
  const bh = useMemo(() => downsample(buyHold, MAX_POINTS), [buyHold]);
  const domain = useMemo(() => {
    const shown = [...(showEquity ? [eq] : []), ...(showBuyHold ? [bh] : [])];
    return valueDomain(shown.length ? shown : [eq], [initialCapital]);
  }, [eq, bh, showEquity, showBuyHold, initialCapital]);

  if (eq.length < 2) {
    return <div className="pine-chart-empty">The equity curve appears once the chart has bars and the strategy has run.</div>;
  }

  const hoverIdx = hover === null ? null : nearestIndex(eq, hover);
  const hoverPoint = hoverIdx === null || hoverIdx < 0 ? null : eq[hoverIdx];
  const hoverBuyHold = hoverPoint ? bh[nearestIndex(bh, (hoverPoint.time - eq[0].time) / Math.max(eq[eq.length - 1].time - eq[0].time, 1))] : null;
  const hoverX = hoverPoint ? ((hoverPoint.time - eq[0].time) / Math.max(eq[eq.length - 1].time - eq[0].time, 1)) * 100 : 0;

  return (
    <div className="pine-chart">
      <div className="pine-chart-legend">
        <label className="pine-chart-toggle equity">
          <input type="checkbox" checked={showEquity} onChange={(e) => setShowEquity(e.currentTarget.checked)} />
          <span className="swatch" aria-hidden="true" />
          Equity
        </label>
        {bh.length > 0 && (
          <label className="pine-chart-toggle buyhold">
            <input type="checkbox" checked={showBuyHold} onChange={(e) => setShowBuyHold(e.currentTarget.checked)} />
            <span className="swatch" aria-hidden="true" />
            {benchmarkLabel}
          </label>
        )}
      </div>

      <div
        className="pine-chart-plot"
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setHover((e.clientX - box.left) / box.width);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Equity curve">
          <line className="baseline" x1={0} x2={W} y1={yFor(initialCapital, domain, H)} y2={yFor(initialCapital, domain, H)} vectorEffect="non-scaling-stroke" />
          {showBuyHold && <path className="line buyhold" d={linePath(bh, domain, W, H)} vectorEffect="non-scaling-stroke" />}
          {showEquity && <path className="line equity" d={linePath(eq, domain, W, H)} vectorEffect="non-scaling-stroke" />}
        </svg>
        <span className="axis top">{formatMoney(domain.max)}</span>
        <span className="axis bottom">{formatMoney(domain.min)}</span>
        {hoverPoint && (
          <>
            <div className="cursor" style={{ left: `${hoverX}%` }} />
            <div className={`tip${hoverX > 60 ? ' flip' : ''}`} style={{ left: `${hoverX}%` }}>
              <div className="muted small">{formatWhen(hoverPoint.time)}</div>
              {showEquity && <div>Equity {formatMoney(hoverPoint.value, currency)}</div>}
              {showBuyHold && hoverBuyHold && <div className="muted">{benchmarkLabel} {formatMoney(hoverBuyHold.value, currency)}</div>}
            </div>
          </>
        )}
      </div>

      <div className="pine-chart-x">
        <span>{formatWhen(eq[0].time)}</span>
        <span>{formatWhen(eq[eq.length - 1].time)}</span>
      </div>
    </div>
  );
}
