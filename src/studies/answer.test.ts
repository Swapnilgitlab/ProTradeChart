import { describe, expect, it } from 'vitest';
import engineResult from './fixtures/engine-result.json';
import { answer, coverageLine, groupNames, measureSentence } from './answer';
import { MEASURE_STATUSES, parseStudyResult, type MeasureResult, type MeasureStatus, type StudyResultData, type TestResult } from './result';
import { normalizeSpec, type Measure } from './spec';

const fixture = () => parseStudyResult(structuredClone(engineResult))!;

const zone = [
  { left: 'dist_ema_21', op: '>=' as const, right: 0 },
  { left: 'dist_ema_21', op: '<=' as const, right: 0.03 },
];

function measure(over: Partial<Measure> & Pick<Measure, 'stat'>): Measure {
  return { label: 'Closed within 3% above its 21 EMA', conditions: zone, feature: null, window: { start: { offset: -252 }, end: { offset: 0 } }, headline: true, ...over };
}

function status(over: Partial<Record<MeasureStatus, number>> = {}): Record<MeasureStatus, number> {
  return { ...(Object.fromEntries(MEASURE_STATUSES.map((s) => [s, 0])) as Record<MeasureStatus, number>), ...over };
}

function result(over: Partial<MeasureResult> & Pick<MeasureResult, 'stat'>): MeasureResult {
  return {
    index: 0,
    label: 'Closed within 3% above its 21 EMA',
    events: { count: 76, mean: 0.25, median: 0.2381, min: 0.02, max: 0.7, p25: 0.18, p75: 0.31, status: status({ ok: 76 }) },
    control: { count: 150, mean: 0.15, median: 0.14, min: 0, max: 0.5, p25: 0.08, p75: 0.2, status: status({ ok: 150 }) },
    window_bars: null,
    test: null,
    histogram: null,
    timeline: null,
    ...over,
  };
}

const standingOut: TestResult = { p: 0.00001, q: 0.0001, n_events: 76, n_control: 150, effect: 0.62, diff: null, low: null, high: null };

describe('the sentence for a measure', () => {
  it('answers a share-of-days question with the typical stock, the middle half and the comparison', () => {
    const text = measureSentence(result({ stat: 'share', test: standingOut }), measure({ stat: 'share' }), 'Random stock-dates');
    expect(text).toBe(
      'For the typical stock, “Closed within 3% above its 21 EMA” held on 24% of days in the 12 months up to and including the event (about 60 of 252).' +
        ' Middle half: 18%–31%. Random stock-dates: 14% — a large difference (q < 0.001).',
    );
  });

  it('says plainly when the difference doesn’t stand out, and leaves the comparison out when there is none', () => {
    const noClear: TestResult = { ...standingOut, q: 0.4, effect: 0.05 };
    expect(measureSentence(result({ stat: 'share', test: noClear }), measure({ stat: 'share' }), 'Random stock-dates')).toContain('— no clear difference.');
    expect(measureSentence(result({ stat: 'share' }), measure({ stat: 'share' }), null)).not.toContain('stock-dates');
  });

  it('counts days, streaks and separate stretches', () => {
    const days = result({ stat: 'count', events: { ...result({ stat: 'count' }).events, median: 61, p25: 45, p75: 78 } });
    expect(measureSentence(days, measure({ stat: 'count' }), null)).toBe(
      'For the typical stock, “Closed within 3% above its 21 EMA” held on 61 days in the 12 months up to and including the event (of 252). Middle half: 45–78.',
    );
    expect(measureSentence({ ...days, stat: 'longest_run' }, measure({ stat: 'longest_run' }), null)).toContain('longest unbroken run of “Closed within 3% above its 21 EMA” in the 12 months up to and including the event was 61 days');
    const once = { ...days, stat: 'runs' as const, events: { ...days.events, median: 1 } };
    expect(measureSentence(once, measure({ stat: 'runs' }), null)).toContain('started 1 separate time in the 12 months');
  });

  it('reports a first occurrence with how many never saw it, and says so when most never did', () => {
    const after = measure({ stat: 'bars_to_first', label: 'Closed below its 50 SMA', window: { start: { offset: 0 }, end: { offset: 126 } } });
    const some = result({ stat: 'bars_to_first', label: 'Closed below its 50 SMA', events: { count: 50, mean: null, median: 34, min: 3, max: null, p25: 12, p75: null, status: status({ ok: 40, never: 10 }) } });
    expect(measureSentence(some, after, null)).toBe(
      'For the typical stock, “Closed below its 50 SMA” first held 34 days after the event (in the 6 months after the event); 10 of 50 never saw it.',
    );
    const most = result({ stat: 'bars_to_first', label: 'Closed below its 50 SMA', events: { count: 50, mean: null, median: null, min: 3, max: null, p25: 20, p75: null, status: status({ ok: 20, never: 30 }) } });
    expect(measureSentence(most, after, null)).toBe('More than half (30 of 50) never saw “Closed below its 50 SMA” in the 6 months after the event.');
  });

  it('gives an episode’s length with the ones still going at the limit', () => {
    const episode = measure({
      stat: 'length',
      label: 'Trend',
      conditions: [],
      window: { start: { offset: 0 }, end: { find: 'first', feature: null, conditions: [{ left: 'close', op: '<', right: 'sma_50' }], direction: 'after', within: 252, if_not_found: 'cap' } },
    });
    const r = result({ stat: 'length', label: 'Trend', events: { count: 40, mean: 90, median: 71, min: 4, max: 252, p25: 30, p75: 140, status: status({ ok: 34, capped: 6 }) } });
    expect(measureSentence(r, episode, null)).toBe(
      'The typical episode from the event until “Close < SMA 50” first held (looking up to 12 months ahead) lasted 71 trading days. Middle half: 30–140. 6 of 40 were still going at the limit of the search and count as that long.',
    );
  });

  it('describes price measures and feature measures', () => {
    const fall = result({ stat: 'max_drawdown', events: { ...result({ stat: 'max_drawdown' }).events, median: -0.281, p25: -0.4, p75: -0.15 } });
    expect(measureSentence(fall, measure({ stat: 'max_drawdown', conditions: [], window: { start: { offset: 0 }, end: { offset: 126 } } }), null)).toContain(
      'worst peak-to-trough fall in the 6 months after the event was -28.1% (on closing prices)',
    );
    const rsi = result({ stat: 'mean', events: { ...result({ stat: 'mean' }).events, median: 61.2, p25: 55, p75: 66 } });
    expect(measureSentence(rsi, measure({ stat: 'mean', conditions: [], feature: 'rsi_14' }), null)).toContain('The typical stock’s average RSI 14 in the 12 months up to and including the event was 61.2.');
  });
});

describe('coverage', () => {
  it('says how many events were measured and why the rest weren’t', () => {
    const r = result({ stat: 'share', events: { ...result({ stat: 'share' }).events, status: status({ ok: 50, too_recent: 20, no_history: 6 }) } });
    expect(coverageLine(r, 76)).toBe('Measured for 50 of 76 events; 20 are too recent for this window, 6 lack enough history.');
    expect(coverageLine(result({ stat: 'share' }), 76)).toBeNull();
  });

  it('warns that capped values are lower bounds', () => {
    const r = result({ stat: 'count', events: { ...result({ stat: 'count' }).events, status: status({ ok: 70, capped: 6 }) } });
    expect(coverageLine(r, 76)).toBe('6 windows ran to the limit of the search, so their values are a lower bound.');
  });
});

describe('the answer', () => {
  it('leads with the headline measures of a result', () => {
    const data = fixture();
    const a = answer(data);
    expect(a.fallback).toBe(false);
    expect(a.lines.map((l) => l.index)).toEqual([0]); // only the first measure is a headline in the fixture
    expect(a.lines[0].text).toContain('“Above the 50 EMA” held on');
    expect(a.lines[0].text).toContain('Random stock-dates:');
  });

  it('falls back to snapshots, forward returns and findings for a result without measures', () => {
    const data: StudyResultData = { ...fixture(), measures: [] };
    data.spec = normalizeSpec({ ...data.spec, measures: [] });
    const a = answer(data);
    expect(a.fallback).toBe(true);
    expect(a.lines[0].text).toBe('This Study takes snapshots around the event; it doesn’t measure anything over time.');
    expect(a.lines.some((l) => l.text.startsWith('Over the next '))).toBe(true);
  });

  it('names the comparison group by the kind of comparison', () => {
    const data = fixture();
    expect(groupNames(data).comparison).toBe('Random stock-dates');
    expect(groupNames({ ...data, summary: { ...data.summary, control_kind: 'outcome' } }).comparison).toBe('Events that didn’t reach the outcome');
    expect(groupNames({ ...data, summary: { ...data.summary, control_kind: 'none' } }).comparison).toBeNull();
  });
});
