import type { CurvePoint } from '../../pine/tester';

/** At most `max` points, always keeping the first and last so the curve still starts and
 *  ends where it really does. A stride keeps the shape of an equity curve well enough at
 *  the width the panel is drawn. */
export function downsample<T>(points: readonly T[], max: number): T[] {
  if (points.length <= max || max < 2) return points.slice();
  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max - 1; i++) out.push(points[Math.round(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

export interface Domain {
  min: number;
  max: number;
}

/** The value range of the given curves, with headroom, and never a zero-height range. */
export function valueDomain(curves: readonly (readonly CurvePoint[])[], include: readonly number[] = []): Domain {
  let min = Infinity;
  let max = -Infinity;
  for (const v of include) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  for (const curve of curves) {
    for (const p of curve) {
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min: min - 1, max: max + 1 };
  const pad = (max - min) * 0.06;
  return { min: min - pad, max: max + pad };
}

/** An SVG path through `points`, scaled into a `width` x `height` box. */
export function linePath(points: readonly CurvePoint[], domain: Domain, width: number, height: number): string {
  if (points.length === 0) return '';
  const t0 = points[0].time;
  const span = Math.max(points[points.length - 1].time - t0, 1);
  const range = domain.max - domain.min;
  return points
    .map((p, i) => {
      const x = ((p.time - t0) / span) * width;
      const y = height - ((p.value - domain.min) / range) * height;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

/** The y position of a value in the same box (for the starting-capital baseline). */
export function yFor(value: number, domain: Domain, height: number): number {
  return height - ((value - domain.min) / (domain.max - domain.min)) * height;
}

/** The point nearest to a horizontal fraction (0 to 1) of the curve's time span. */
export function nearestIndex(points: readonly CurvePoint[], fraction: number): number {
  if (points.length === 0) return -1;
  const t0 = points[0].time;
  const target = t0 + Math.min(Math.max(fraction, 0), 1) * (points[points.length - 1].time - t0);
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].time < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && target - points[lo - 1].time < points[lo].time - target) return lo - 1;
  return lo;
}
