import { describe, expect, it } from 'vitest';
import engine from './fixtures/engine-result.json';
import { parseScreenResult, screenCsv, sortScreenRows, type ScreenRow } from './result';

/** The engine's real output (python/tests/test_screen.py keeps it current), with what varies per run filled back in. */
function posted(): Record<string, unknown> {
  const data = structuredClone(engine) as Record<string, unknown> & { meta: Record<string, unknown> };
  data.meta = { ...data.meta, executed_at: '2025-07-01T10:00:00Z', seconds: 1.5, engine_build: 'abcd1234' };
  return data;
}

describe('parseScreenResult', () => {
  it('reads what the engine posts', () => {
    const result = parseScreenResult(posted());
    expect(result).not.toBeNull();
    expect(result!.columns).toEqual(['close', 'return_1', 'ema_50']);
    expect(result!.rows.map((r) => r.symbol)).toEqual(['zerodha:NSE:FAST', 'zerodha:NSE:UP']);
    expect(result!.rows[0]).toMatchObject({ name: 'Fast', date: '2025-06-30' });
    expect(result!.meta).toMatchObject({ asOf: '2025-06-30', requested: 5, loaded: 4, failed: 1, stale: 1, matched: 2, prefiltered: 0, seconds: 1.5 });
    expect(result!.warnings.map((w) => w.code)).toEqual(['load_failed', 'stale']);
  });

  it('refuses what it does not recognise rather than guessing', () => {
    const cases: [string, (d: Record<string, any>) => void][] = [
      ['another format', (d) => (d.format = 2)],
      ['an invalid spec', (d) => (d.spec.universe.provider = 'nosuch')],
      ['columns other than the spec’s', (d) => (d.columns = ['close', 'ema_50', 'return_1'])],
      ['a row missing a value', (d) => d.rows[0].values.pop()],
      ['a value that is not a number', (d) => (d.rows[0].values[0] = '<img src=x>')],
      ['a symbol with no source', (d) => (d.rows[0].symbol = 'FAST')],
      ['a malformed date', (d) => (d.rows[0].date = 'yesterday')],
      ['a name that is not text', (d) => (d.rows[0].name = { html: 'x' })],
      ['fewer matches than rows', (d) => (d.meta.matched = 1)],
      ['no as-of date', (d) => delete d.meta.as_of],
      ['a pre-filtered count that is not a count', (d) => (d.meta.prefiltered = -1)],
      ['rows that are not a list', (d) => (d.rows = {})],
    ];
    for (const [what, spoil] of cases) {
      const data = posted() as Record<string, any>;
      spoil(data);
      expect(parseScreenResult(data), what).toBeNull();
    }
    expect(parseScreenResult(null)).toBeNull();
  });

  it('reads a result saved before the quote pre-filter as having ruled nothing out', () => {
    const data = posted() as Record<string, any>;
    delete data.meta.prefiltered;
    expect(parseScreenResult(data)!.meta.prefiltered).toBe(0);
  });

  it('keeps well-formed warnings only', () => {
    const data = posted() as Record<string, any>;
    data.warnings = [{ code: 'x', message: 'fine' }, { code: 7, message: 'no' }, 'nope', { code: 'y', message: 'z'.repeat(501) }];
    expect(parseScreenResult(data)!.warnings).toEqual([{ code: 'x', message: 'fine' }]);
  });
});

describe('sortScreenRows', () => {
  const row = (symbol: string, name: string | null, v: number | null): ScreenRow => ({ symbol, name, date: '2025-06-30', values: [v] });
  const rows = [row('zerodha:NSE:B', 'Bee', 2), row('zerodha:NSE:A', null, null), row('zerodha:BSE:C', 'Cee', 5)];
  const order = (sorted: ScreenRow[]) => sorted.map((r) => r.symbol.split(':').pop());

  it('sorts by a column either way, blanks last', () => {
    expect(order(sortScreenRows(rows, { key: 0, descending: true }))).toEqual(['C', 'B', 'A']);
    expect(order(sortScreenRows(rows, { key: 0, descending: false }))).toEqual(['B', 'C', 'A']);
    expect(order(sortScreenRows(rows, { key: 'name', descending: false }))).toEqual(['B', 'C', 'A']);
  });

  it('sorts symbols as they are shown', () => {
    // BSE:C is shown with its exchange; NSE isn't.
    expect(order(sortScreenRows(rows, { key: 'symbol', descending: false }))).toEqual(['A', 'B', 'C']);
  });

  it('keeps the engine’s order unsorted, without changing the input', () => {
    expect(sortScreenRows(rows, null)).toEqual(rows);
    sortScreenRows(rows, { key: 0, descending: true });
    expect(order(rows)).toEqual(['B', 'A', 'C']);
  });
});

describe('screenCsv', () => {
  it('writes raw numbers under readable headings', () => {
    const result = parseScreenResult(posted())!;
    const [head, first] = screenCsv(result).split('\r\n');
    expect(head).toBe('Symbol,Name,Date,Close,1D return,EMA 50');
    expect(first.startsWith('zerodha:NSE:FAST,Fast,2025-06-30,260,')).toBe(true);
  });
});
