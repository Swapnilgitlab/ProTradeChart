import { describe, expect, it } from 'vitest';
import engineResult from './fixtures/engine-result.json';
import { compareRuns, defaultCompareOffset, specDifferences } from './compare';
import { parseStudyResult, type StudyResultData } from './result';

const run = (edit: (raw: Record<string, any>) => void = () => {}): StudyResultData => {
  const raw = structuredClone(engineResult) as Record<string, any>;
  edit(raw);
  return parseStudyResult(raw)!;
};

describe('comparing runs', () => {
  it('finds no differences between a run and itself', () => {
    const a = run();
    expect(specDifferences(a, a)).toEqual([]);
    const c = compareRuns(a, a);
    expect(c.metrics.every((m) => m.gap === 0 || m.gap === null)).toBe(true);
  });

  it('describes how two specs differ, in the builder’s words', () => {
    const a = run();
    const b = run((raw) => {
      raw.spec.event.conditions[0].right = 2;
      raw.spec.period.start = '2020-01-01';
    });
    const parts = specDifferences(a, b).map((d) => d.part);
    expect(parts).toContain('Event');
    expect(parts).toContain('Study period');
    expect(specDifferences(a, b).find((d) => d.part === 'Event')!.b).toContain('+200%');
  });

  it('lines up only what both measured, at a shared observation point', () => {
    const a = run();
    const b = run((raw) => {
      raw.spec.metrics = ['return_63', 'adx_14'];
      raw.spec.lookback_windows = [63, 21];
      raw.offsets = [-63, -21, 0, 63, 126];
      raw.summary.events = 5;
    });
    const c = compareRuns(a, b);
    expect(c.offsets).toEqual([-63, -21, 0, 63, 126]);
    expect(defaultCompareOffset(a, b)).toBe(-21);
    expect(c.metrics.map((m) => m.label)).toEqual(['3M return']);
    expect(c.summary[0]).toMatchObject({ label: 'Events', a: 1, b: 5, gap: 4 });
    expect(compareRuns(a, b, -63).metrics[0].a).toBe(a.stats.find((s) => s.metric === 'return_63' && s.offset === -63)!.events.median);
  });

  it('lines up the measures both runs have, by label and stat', () => {
    const a = run();
    const b = run((raw) => {
      raw.measures[0].events.median = 0.5;
      raw.measures[1].label = 'Another measure';
      raw.spec.measures[1].label = 'Another measure';
    });
    const c = compareRuns(a, b);
    expect(c.measures.map((m) => m.label)).toEqual(['Above the 50 EMA (share of days)']);
    expect(c.measures[0]).toMatchObject({ unit: 'share', b: 0.5 });
    expect(c.measures[0].gap).toBeCloseTo(0.5 - (a.measures[0].events.median ?? 0));
  });
});
