import { describe, expect, it } from 'vitest';
import engineResult from './fixtures/engine-result.json';
import { eventRecord, parseRunSummary, parseStudyResult, runSummary, statFor } from './result';

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
    expect(event.symbol).toBe('zerodha:NSE:WIN');
    expect(event.name).toBe('Winner Ltd');
    expect(typeof event['rsi_14@-63']).toBe('number');
    expect(statFor(r, 'return_63', -63)?.events.count).toBe(1);
    expect(r.characteristics.find((c) => c.offset === -21)?.events.share).toBe(1);
    expect(r.histograms.length).toBeGreaterThan(0);
    expect(r.path?.offsets).toContain(0);
    expect(r.availability.market_cap).toBe(false);
    expect(r.warnings.map((w) => w.code)).toContain('market_cap_unavailable');
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
    raw.events = { columns: ['symbol', 'x'], rows: [['zerodha:NSE:A', { html: '<b>' }, 'extra'], ['zerodha:NSE:B']], total: -4 };
    raw.histograms = [{ metric: 'rsi_14', offset: 0, edges: [0, 1], events: [1, 2], control: [0] }];
    raw.stats = [{ metric: 'rsi_14', offset: 'x' }];
    raw.warnings = [{ code: 'x', message: 7 }, 'nope'];
    const r = parseStudyResult(raw)!;
    expect(r.events.rows).toEqual([
      ['zerodha:NSE:A', null],
      ['zerodha:NSE:B', null],
    ]);
    expect(r.events.total).toBe(2);
    expect(r.histograms).toEqual([]);
    expect(r.stats).toEqual([]);
    expect(r.warnings).toEqual([]);
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
