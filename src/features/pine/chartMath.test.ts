import { describe, expect, it } from 'vitest';
import { downsample, linePath, nearestIndex, valueDomain, yFor } from './chartMath';

const curve = (values: number[]) => values.map((value, i) => ({ time: i * 10, value }));

describe('downsample', () => {
  it('keeps short series whole', () => {
    expect(downsample([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it('caps the length and keeps the first and last points', () => {
    const many = Array.from({ length: 1000 }, (_, i) => i);
    const out = downsample(many, 50);
    expect(out).toHaveLength(50);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(999);
    expect([...out].sort((a, b) => a - b)).toEqual(out); // still in order
  });
});

describe('valueDomain', () => {
  it('pads the range and includes extra values', () => {
    const d = valueDomain([curve([100, 110])], [90]);
    expect(d.min).toBeLessThan(90);
    expect(d.max).toBeGreaterThan(110);
  });

  it('never returns an empty range', () => {
    const flat = valueDomain([curve([5, 5, 5])]);
    expect(flat.max).toBeGreaterThan(flat.min);
    expect(valueDomain([])).toEqual({ min: 0, max: 1 });
  });
});

describe('linePath', () => {
  it('scales points into the box, low values at the bottom', () => {
    const d = { min: 0, max: 10 };
    expect(linePath(curve([0, 10]), d, 100, 50)).toBe('M0.00 50.00 L100.00 0.00');
    expect(linePath([], d, 100, 50)).toBe('');
    expect(yFor(5, d, 50)).toBe(25);
  });
});

describe('nearestIndex', () => {
  const pts = curve([1, 2, 3, 4, 5]); // times 0, 10, 20, 30, 40
  it('finds the closest point to a fraction of the span', () => {
    expect(nearestIndex(pts, 0)).toBe(0);
    expect(nearestIndex(pts, 1)).toBe(4);
    expect(nearestIndex(pts, 0.5)).toBe(2);
    expect(nearestIndex(pts, 0.62)).toBe(2); // t=24.8, nearer 20 than 30
    expect(nearestIndex(pts, 0.68)).toBe(3); // t=27.2
  });

  it('clamps out-of-range fractions and copes with no points', () => {
    expect(nearestIndex(pts, -3)).toBe(0);
    expect(nearestIndex(pts, 9)).toBe(4);
    expect(nearestIndex([], 0.5)).toBe(-1);
  });
});
