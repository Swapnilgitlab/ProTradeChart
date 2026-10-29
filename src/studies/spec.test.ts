import { describe, expect, it } from 'vitest';
import cases from './fixtures/spec-cases.json';
import {
  conditionText,
  describeCondition,
  interpret,
  measureColumn,
  measureReach,
  metricColumn,
  normalizeSpec,
  parseCondition,
  specProblem,
  studyOffsets,
  type StudySpec,
} from './spec';

/** The placeholders spec-cases.json uses for values too long to write out (test_measures.py expands them the same way). */
function expand(value: unknown): unknown {
  const one = cases.base.measures[0];
  if (value === 'QUESTION_TOO_LONG') return 'x'.repeat(501);
  if (value === 'LABEL_TOO_LONG') return 'x'.repeat(121);
  if (value === 'THIRTEEN_MEASURES') return Array.from({ length: 13 }, () => structuredClone(one));
  if (value === 'FOUR_HEADLINES') return Array.from({ length: 4 }, () => structuredClone(one));
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
  return value;
}

const patched = (patch: object) => ({ ...structuredClone(cases.base), ...(expand(structuredClone(patch)) as object) });

describe('the cases shared with the engine (fixtures/spec-cases.json)', () => {
  it('accepts the base case', () => {
    expect(specProblem(cases.base)).toBeNull();
  });

  it('refuses each refused case, naming the problem as the engine does', () => {
    for (const c of cases.refused) expect(specProblem(patched(c.patch)), c.word).toContain(c.word);
  });

  it('normalises each accepted case to exactly the measures the engine does', () => {
    for (const c of cases.accepted) {
      const spec = normalizeSpec(patched(c.patch));
      if ('measures' in c) expect(spec.measures, c.name).toEqual(c.measures);
      if ('provider' in c) expect(spec.universe.provider, c.name).toBe(c.provider);
      if ('symbols' in c) expect(spec.universe.symbols, c.name).toEqual(c.symbols);
      if ('benchmark' in c) expect(spec.benchmark, c.name).toBe(c.benchmark);
      expect(normalizeSpec(spec), c.name).toEqual(spec);
    }
  });
});

describe('measures', () => {
  it('name their table columns as the engine does', () => {
    expect(measureColumn(0)).toBe('measure_0');
    expect(measureColumn(2, 'status')).toBe('measure_2_status');
    expect(measureColumn(1, 'from')).toBe('measure_1_from');
  });

  it('say how far back they read, including a found start and the bar before a cross', () => {
    const spec = normalizeSpec(
      patched({
        measures: [
          { stat: 'return', window: { start: { offset: -300 }, end: { offset: 0 } } },
          { stat: 'length', window: { start: { find: 'lowest', feature: 'close', within: 400 }, end: { offset: 0 } } },
          { stat: 'count', conditions: ['rsi_14 crosses_above 50'], window: { start: { offset: 0 }, end: { offset: 63 } } },
        ],
      }),
    );
    expect(spec.measures.map(measureReach)).toEqual([300, 400, 1]);
  });

  it('are read out in the interpretation, with the question', () => {
    const spec = normalizeSpec(patched({ question: 'How often did doublers sit near the 21 EMA?' }));
    const text = interpret(spec)
      .map((s) => `${s.heading}: ${s.lines.join('; ')}`)
      .join('\n');
    expect(text).toContain('Question: How often did doublers sit near the 21 EMA?');
    expect(text).toContain('What is measured: “Closed within 3% above its 21 EMA” — share of days, in the 12 months up to and including the event');
    expect(text).not.toContain('Metrics:');
  });
});

const minimal = (over: Record<string, unknown> = {}) => ({
  name: '100% Winners',
  period: { start: '2018-01-01' },
  event: { conditions: ['return_12m crosses_above 1'] },
  metrics: ['return_63', 'rsi_14'],
  ...over,
});

describe('normalizeSpec', () => {
  it('completes a spec with the same defaults as the engine', () => {
    const spec = normalizeSpec(minimal());
    expect(spec.version).toBe(1);
    expect(spec.event.conditions).toEqual([{ left: 'return_252', op: 'crosses_above', right: 1 }]);
    expect(spec.event.label).toBe('return_252 crosses_above 1');
    expect(spec.event.cooldown_days).toBe(252);
    expect(spec.lookback_windows).toEqual([21, 63, 126, 252]);
    expect(spec.forward_windows).toEqual([63, 126, 252]);
    expect(spec.universe).toMatchObject({ source: 'instruments', provider: 'india', exchanges: ['NSE'], series: ['EQ'], market_cap_min: null });
    expect(spec.control_group).toEqual({ enabled: true, samples_per_event: 2, seed: 42 });
    expect(spec.output.max_events).toBe(5000);
    expect(spec.outcome).toBeNull();
    expect(spec.question).toBe('');
    expect(spec.measures).toEqual([]);
    expect(normalizeSpec(spec)).toEqual(spec);
  });

  it('refuses what the engine would refuse, naming the field', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ name: '' }, 'name'],
      [{ version: 2 }, 'version'],
      [{ period: { start: null } }, 'period.start'],
      [{ period: { start: '2020-01-01', end: '2019-01-01' } }, 'period.end'],
      [{ period: { start: '2020-13-45' } }, 'period.start'],
      [{ event: { conditions: [] } }, 'event.conditions'],
      [{ metrics: ['nonsense_3'] }, 'metrics'],
      [{ universe: { source: 'watchlist' } }, 'universe.watchlist'],
      [{ universe: { exchanges: ['NYSE'] } }, 'universe.exchanges'],
      [{ universe: { series: ['GB'] } }, 'universe.series'],
      [{ universe: { series: [] } }, 'universe.series'],
      [{ metrics: ['rs_126'] }, 'benchmark'],
      [{ lookback_windows: [0] }, 'lookback_windows'],
      [{ outcome: { window: 63 } }, 'outcome.min_return'],
    ];
    for (const [change, word] of cases) expect(specProblem(minimal(change))).toContain(word);
    expect(specProblem(minimal())).toBeNull();
    expect(specProblem('nope')).toContain('JSON object');
  });
});

describe('conditions', () => {
  it('are read from text or objects', () => {
    expect(parseCondition('close > EMA_200')).toEqual({ left: 'close', op: '>', right: 'ema_200' });
    expect(parseCondition({ left: 'rsi_14', op: '<', right: 30, label: ' Oversold ' })).toEqual({ left: 'rsi_14', op: '<', right: 30, label: 'Oversold' });
    expect(() => parseCondition('close ~ 3')).toThrow();
    expect(() => parseCondition({ left: 'close', op: '>', right: true })).toThrow();
  });

  it('are described for people and for the engine', () => {
    const c = parseCondition('return_252 crosses_above 1');
    expect(describeCondition(c)).toBe('12M return crosses above +100%');
    expect(conditionText(c)).toBe('return_252 crosses_above 1');
    expect(describeCondition(parseCondition('close > ema_200'))).toBe('Close > EMA 200');
    expect(describeCondition(parseCondition('rvol_20 > 2'))).toBe('Relative volume (20D) > 2');
  });
});

describe('observation points', () => {
  it('run from the furthest look-back to the last forward window', () => {
    const spec = normalizeSpec(minimal({ forward_windows: [63, 126] }));
    expect(studyOffsets(spec)).toEqual([-252, -126, -63, -21, 0, 63, 126]);
    expect(metricColumn('rsi_14', -63)).toBe('rsi_14@-63');
    expect(metricColumn('rsi_14', 0)).toBe('rsi_14@0');
    expect(metricColumn('rsi_14', 63)).toBe('rsi_14@+63');
  });
});

describe('interpret', () => {
  it('says in words what will run, including a market-cap floor and an outcome', () => {
    const spec: StudySpec = normalizeSpec(
      minimal({ universe: { exchanges: ['NSE', 'BSE'], market_cap_min: 1e10 }, outcome: { window: 126, min_return: 0.3 } }),
    );
    const text = interpret(spec)
      .map((s) => `${s.heading}: ${s.lines.join('; ')}`)
      .join('\n');
    expect(text).toContain('NSE + BSE listed ordinary shares');
    expect(text).toContain('Market cap > ₹1,000 Cr');
    expect(text).toContain('12M return crosses above +100%');
    expect(text).toContain('6M before the event');
    expect(text).toContain('rose 30% or more within 6M');
  });
});
