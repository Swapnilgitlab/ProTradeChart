import { describe, expect, it } from 'vitest';
import { formatMeasure, headlineMeasures, measureUnit, presetOf, span, windowPhrase, windowSide, WINDOW_PRESETS } from './measures';
import { normalizeSpec } from './spec';
import type { Measure } from './spec';

const fixed = (start: number, end: number): Measure['window'] => ({ start: { offset: start }, end: { offset: end } });
const below50 = [{ left: 'close', op: '<' as const, right: 'sma_50' }];

describe('what a window covers, in words', () => {
  it('reads fixed windows around the event', () => {
    expect(windowPhrase(fixed(-252, 0))).toBe('in the 12 months up to and including the event');
    expect(windowPhrase(fixed(0, 126))).toBe('in the 6 months after the event');
    expect(windowPhrase(fixed(-252, -63))).toBe('from 12 months to 3 months before the event');
    expect(windowPhrase(fixed(21, 63))).toBe('from 1 month to 3 months after the event');
    expect(windowPhrase(fixed(-63, 21))).toBe('from 3 months before to 1 month after the event');
    expect(windowPhrase(fixed(-40, 0))).toBe('in the 40 trading days up to and including the event');
  });

  it('reads windows that start or end on a day found near the event', () => {
    const fromLow: Measure['window'] = {
      start: { find: 'lowest', feature: 'close', conditions: [], direction: 'before', within: 252, if_not_found: 'cap' },
      end: { offset: 0 },
    };
    expect(windowPhrase(fromLow)).toBe('from its lowest close of the prior 12 months to the event');
    const untilBreak: Measure['window'] = {
      start: { offset: 0 },
      end: { find: 'first', feature: null, conditions: below50, direction: 'after', within: 252, if_not_found: 'cap' },
    };
    expect(windowPhrase(untilBreak)).toBe('from the event until “Close < SMA 50” first held (looking up to 12 months ahead)');
    const since: Measure['window'] = {
      start: { find: 'last', feature: null, conditions: below50, direction: 'before', within: 504, if_not_found: 'skip' },
      end: { offset: 0 },
    };
    expect(windowPhrase(since)).toBe('from the last day “Close < SMA 50” held (looking back up to 2 years) to the event');
  });

  it('knows which side of the event a window looks at', () => {
    expect(windowSide(fixed(-252, 0))).toBe('before');
    expect(windowSide(fixed(0, 126))).toBe('after');
    expect(windowSide(fixed(-21, 21))).toBe('spanning');
    const lowToEvent: Measure['window'] = {
      start: { find: 'lowest', feature: 'close', conditions: [], direction: 'before', within: 252, if_not_found: 'cap' },
      end: { offset: 0 },
    };
    expect(windowSide(lowToEvent)).toBe('before');
    const afterBreak: Measure['window'] = {
      start: { offset: -10 },
      end: { find: 'first', feature: null, conditions: below50, direction: 'after', within: 60, if_not_found: 'cap' },
    };
    expect(windowSide(afterBreak)).toBe('spanning');
  });

  it('spells out spans people say in months', () => {
    expect(span(21)).toBe('1 month');
    expect(span(504)).toBe('2 years');
    expect(span(1)).toBe('1 trading day');
  });
});

describe('a measure’s values', () => {
  it('have the unit of what they count', () => {
    expect(measureUnit({ stat: 'share', feature: null })).toBe('share');
    expect(measureUnit({ stat: 'count', feature: null })).toBe('bars');
    expect(measureUnit({ stat: 'runs', feature: null })).toBe('count');
    expect(measureUnit({ stat: 'max_drawdown', feature: null })).toBe('percent');
    expect(measureUnit({ stat: 'mean', feature: 'rsi_14' })).toBe('number');
    expect(measureUnit({ stat: 'max', feature: 'close' })).toBe('price');
    expect(measureUnit({ stat: 'change', feature: 'dist_ema_50' })).toBe('points');
    expect(measureUnit({ stat: 'change', feature: 'rsi_14' })).toBe('number');
  });

  it('are written for people, with "never" for a condition that never held', () => {
    expect(formatMeasure(0.2381, 'share')).toBe('24%');
    expect(formatMeasure(0.04, 'share')).toBe('4.0%');
    expect(formatMeasure(127, 'bars')).toBe('127');
    expect(formatMeasure(126.5, 'bars')).toBe('126.5');
    expect(formatMeasure(0.052, 'points')).toBe('+5.2 pts');
    expect(formatMeasure(-0.281, 'percent')).toBe('-28.1%');
    expect(formatMeasure(Number.POSITIVE_INFINITY, 'bars')).toBe('never');
    expect(formatMeasure(null, 'bars')).toBe('—');
  });
});

describe('headline measures', () => {
  it('are those flagged, or else the first', () => {
    expect(headlineMeasures([{ id: 'a', headline: false }, { id: 'b', headline: true }, { id: 'c', headline: true }]).map((m) => m.id)).toEqual(['b', 'c']);
    expect(headlineMeasures([{ id: 'a', headline: false }, { id: 'b', headline: false }]).map((m) => m.id)).toEqual(['a']);
    expect(headlineMeasures([])).toEqual([]);
  });
});

describe('window presets', () => {
  it('are recognised in a window, whatever the unused fields say, and anything else is custom', () => {
    for (const p of WINDOW_PRESETS) expect(presetOf(structuredClone(p.window))).toBe(p.id);
    expect(presetOf(fixed(-100, 0))).toBe('custom');
    const labelled: Measure['window'] = {
      start: { offset: 0 },
      end: { find: 'first', feature: 'rsi_14', conditions: [{ left: 'close', op: '<', right: 'sma_50', label: 'Below 50' }], direction: 'after', within: 252, if_not_found: 'cap' },
    };
    expect(presetOf(labelled)).toBe('until_below_sma50');
  });

  it('are all windows the engine accepts', () => {
    for (const p of WINDOW_PRESETS) {
      const spec = normalizeSpec({ name: 'x', period: { start: '2020-01-01' }, event: { conditions: ['return_252 crosses_above 1'] }, measures: [{ stat: 'return', window: p.window }] });
      expect(spec.measures[0].window, p.id).toBeTruthy();
    }
  });
});

