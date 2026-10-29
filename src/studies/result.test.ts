import { describe, expect, it } from 'vitest';
import engineResult from './fixtures/engine-result.json';
import { eventRecord, measuredCount, parseRunSummary, parseStudyResult, runSummary, statFor } from './result';
import { measureColumn } from './spec';

/** `fixtures/engine-result.json` is real output of the Python engine (python/tests, a synthetic
 *  stock that doubles; regenerate it with python/tests/make_study_fixture.py), so this checks the two
 *  sides agree on the shape. */
const fresh = () => structuredClone(engineResult) as unknown as Record<string, unknown>;

describe('parseStudyResult', () => {
  it('reads what the engine posts', () => {
    const r = parseStudyResult(fresh())!;
    expect(r).not.toBeNull();
    expect(r.spec.name).toBe('100% Winners');
    expect(r.summary.events).toBe(1);
    expect(r.summary.control_kind).toBe('random');
    expect(r.meta.engine_build).toBe('fixture0');
    expect(r.offsets).toEqual([-252, -126, -63, -21, 0, 63, 126]);
    expect(r.events.columns.slice(0, 3)).toEqual(['symbol', 'name', 'event_date']);
    const event = eventRecord(r, r.events.rows[0]);
    expect(event.symbol).toBe('india:NSE:WIN');
    expect(event.name).toBe('Winner Ltd');
    expect(typeof event['rsi_14@-63']).toBe('number');
    expect(statFor(r, 'return_63', -63)?.events.count).toBe(1);
    expect(r.characteristics.find((c) => c.offset === -21)?.events.share).toBe(1);
    expect(r.histograms.length).toBeGreaterThan(0);
    expect(r.path?.offsets).toContain(0);
    expect(r.availability.market_cap).toBe(false);
    expect(r.warnings.map((w) => w.code)).toContain('market_cap_unavailable');
  });

  it('reads the tests and findings, clamped, and drops malformed findings', () => {
    const raw = fresh();
    const stats = raw.stats as Record<string, unknown>[];
    stats[0].test = { p: 0.001, q: 0.004, n_events: 30, n_control: 60, effect: 1.7 };
    (raw.summary as Record<string, unknown>).findings = [
      { kind: 'metric', metric: 'return_63', offset: -63, test: { p: 0.001, q: 0.004, effect: 0.6, n_events: 30, n_control: 60 } },
      { kind: 'characteristic', label: 'Above 200 EMA', offset: 0, test: { p: 0.01, q: 0.02, diff: 0.3, low: 0.1, high: 0.5 } },
      { kind: 'metric', offset: 0, test: {} },
      { kind: 'html', test: {} },
    ];
    const r = parseStudyResult(raw)!;
    expect(r.stats[0].test).toMatchObject({ q: 0.004, effect: 1, n_events: 30 });
    expect(r.stats[1].test).toBeNull();
    expect(r.summary.findings.map((f) => f.kind)).toEqual(['metric', 'characteristic']);
  });

  it('refuses what isn’t a study result', () => {
    expect(parseStudyResult(null)).toBeNull();
    expect(parseStudyResult({ ...fresh(), format: 2 })).toBeNull();
    expect(parseStudyResult({ ...fresh(), spec: { name: '' } })).toBeNull();
    expect(parseStudyResult({ ...fresh(), events: { columns: [], rows: [] } })).toBeNull();
    expect(parseStudyResult({ ...fresh(), events: { columns: ['a'], rows: ['x'] } })).toBeNull();
  });

  it('squares off and sanitises the parts it keeps', () => {
    const raw = fresh();
    raw.events = { columns: ['symbol', 'x'], rows: [['india:NSE:A', { html: '<b>' }, 'extra'], ['india:NSE:B']], total: -4 };
    raw.histograms = [{ metric: 'rsi_14', offset: 0, edges: [0, 1], events: [1, 2], control: [0] }];
    raw.stats = [{ metric: 'rsi_14', offset: 'x' }];
    raw.warnings = [{ code: 'x', message: 7 }, 'nope'];
    const r = parseStudyResult(raw)!;
    expect(r.events.rows).toEqual([
      ['india:NSE:A', null],
      ['india:NSE:B', null],
    ]);
    expect(r.events.total).toBe(2);
    expect(r.histograms).toEqual([]);
    expect(r.stats).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe('measures in a result', () => {
  it('reads each measure with its comparison, status counts, histogram and timeline', () => {
    const r = parseStudyResult(fresh())!;
    expect(r.spec.question).toBe('What did stocks look like on the way to doubling?');
    expect(r.measures.map((m) => [m.index, m.label, m.stat])).toEqual([
      [0, 'Above the 50 EMA', 'share'],
      [1, 'The run from the 12-month low', 'length'],
    ]);
    const [share, run] = r.measures;
    expect(measuredCount(share.events)).toBe(1);
    expect(share.events.status.ok).toBe(1);
    expect(share.control).not.toBeNull();
    expect(share.histogram?.edges.length).toBe((share.histogram?.events.length ?? 0) + 1);
    expect(share.timeline?.offsets).toContain(0);
    expect(share.timeline?.events.length).toBe(share.timeline?.offsets.length);
    expect(run.timeline).toBeNull();
    expect(run.window_bars?.median).toBe(run.events.median);
    expect(r.events.columns).toContain(measureColumn(1, 'from'));
  });

  it('opens a run made before measures existed, with none', () => {
    const raw = fresh();
    delete raw.measures;
    const spec = raw.spec as Record<string, unknown>;
    delete spec.measures;
    delete spec.question;
    const r = parseStudyResult(raw)!;
    expect(r).not.toBeNull();
    expect(r.measures).toEqual([]);
    expect(r.spec.measures).toEqual([]);
    expect(r.spec.question).toBe('');
  });

  it('drops a measure that doesn’t belong to the spec or is malformed, keeping the rest', () => {
    const raw = fresh();
    const measures = raw.measures as unknown[] as Record<string, unknown>[];
    measures.push({ ...measures[0], index: 7 }, { ...measures[0], stat: 'mood' });
    (measures as unknown[]).push('nope');
    measures[0].timeline = { offsets: [0, 1], events: [0.5], count: [1, 1] }; // misaligned: dropped, measure kept
    measures[0].histogram = { edges: [0, 1, 2], events: [1], control: [1, 1] };
    const r = parseStudyResult(raw)!;
    expect(r.measures.map((m) => m.index)).toEqual([0, 1]);
    expect(r.measures[0].timeline).toBeNull();
    expect(r.measures[0].histogram).toBeNull();
  });

  it('reads a measure finding and refuses one without an index', () => {
    const raw = fresh();
    (raw.summary as Record<string, unknown>).findings = [
      { kind: 'measure', index: 0, label: 'Above the 50 EMA', test: { p: 0.001, q: 0.002, effect: 0.5, n_events: 30, n_control: 60 } },
      { kind: 'measure', label: 'No index', test: { p: 0.001, q: 0.002, effect: 0.5 } },
    ];
    const findings = parseStudyResult(raw)!.summary.findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'measure', index: 0, label: 'Above the 50 EMA' });
  });
});

describe('run summaries', () => {
  it('round-trip through JSON and survive junk', () => {
    const r = parseStudyResult(fresh())!;
    const summary = runSummary(r);
    expect(parseRunSummary(JSON.stringify(summary))).toEqual(summary);
    expect(parseRunSummary('not json')).toBeNull();
  });
});
