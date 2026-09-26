import { describe, expect, it } from 'vitest';
import type { TestResult } from './result';
import { describeFinding, effectWord, formatEffect, formatQ, formatShareDiff, standsOut } from './significance';

const t = (over: Partial<TestResult> = {}): TestResult => ({ p: 0.001, q: 0.004, n_events: 30, n_control: 60, effect: 0.62, diff: null, low: null, high: null, ...over });

describe('significance wording', () => {
  it('names effect sizes with the engine’s thresholds', () => {
    expect([0.1, -0.2, 0.4, -0.9].map(effectWord)).toEqual(['negligible', 'small', 'medium', 'large']);
    expect(effectWord(null)).toBeNull();
    expect(formatEffect(0.623)).toBe('+0.62 large');
    expect(formatEffect(-0.2)).toBe('-0.20 small');
  });

  it('writes q-values and knows what stands out', () => {
    expect(formatQ(0.0002)).toBe('q < 0.001');
    expect(formatQ(0.004)).toBe('q = 0.004');
    expect(formatQ(0.31)).toBe('q = 0.31');
    expect(formatQ(null)).toBe('—');
    expect(standsOut(t())).toBe(true);
    expect(standsOut(t({ q: 0.2 }))).toBe(false);
    expect(standsOut(null)).toBe(false);
  });

  it('describes findings as associations in plain words', () => {
    expect(describeFinding({ kind: 'metric', metric: 'return_63', offset: -63, test: t() }, 'events', 'control dates')).toBe(
      'At T-3M, 3M return was higher among events than among control dates (large effect, q = 0.004).',
    );
    const share = t({ effect: null, diff: 0.34, low: 0.2, high: 0.48 });
    expect(formatShareDiff(share)).toBe('+34 pts (95% CI +20 pts to +48 pts)');
    expect(describeFinding({ kind: 'characteristic', label: 'Above 200 EMA', offset: 0, test: share }, 'events', 'control dates')).toContain(
      '“Above 200 EMA” was more common among events',
    );
    expect(describeFinding({ kind: 'forward', window: 126, test: t({ effect: -0.3 }) }, 'events', 'control dates')).toBe(
      'Over the next 6M, returns were lower among events than among control dates (small effect, q = 0.004).',
    );
  });
});
