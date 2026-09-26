import { describe, expect, it } from 'vitest';
import {
  formatCell,
  formatMetric,
  metricTone,
  parseResult,
  sortRows,
  symbolsOf,
  type Metric,
  type ReportResult,
  type TableResult,
} from './results';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const event = (kind: string, data: unknown, title: string | null = null) => ({ kind, title, data });

const tableData = (over: Record<string, unknown> = {}) => ({
  columns: ['symbol', 'close'],
  rows: [['zerodha:NSE:TCS', 4000.5]],
  totalRows: 1,
  symbolColumn: 0,
  digits: 2,
  ...over,
});

const parseTable = (data: unknown, title: string | null = null) => parseResult(event('table', data, title), 1) as TableResult | null;
const parseReport = (data: unknown) => parseResult(event('report', data), 1) as ReportResult | null;

describe('parsing a table', () => {
  it('keeps the columns, rows and where the symbols are', () => {
    const table = parseTable(tableData(), 'Screen')!;
    expect(table.kind).toBe('table');
    expect(table.title).toBe('Screen');
    expect(table.columns).toEqual(['symbol', 'close']);
    expect(table.rows).toEqual([['zerodha:NSE:TCS', 4000.5]]);
    expect(table.symbolColumn).toBe(0);
    expect(table.totalRows).toBe(1);
    expect(table.digits).toBe(2);
  });

  it('refuses anything that is not a table', () => {
    for (const data of [null, undefined, 5, 'text', [], {}, { columns: ['a'] }, { rows: [[1]] }, { columns: 'a', rows: [] }, { columns: [1], rows: [] }, { columns: [], rows: [] }]) {
      expect(parseTable(data), JSON.stringify(data) ?? 'undefined').toBeNull();
    }
    expect(parseTable(tableData({ rows: [1, 2] }))).toBeNull();
  });

  it('makes every row the width of the columns, however ragged it arrived', () => {
    const table = parseTable(tableData({ rows: [['a'], ['b', 1, 'extra'], []] }))!;
    expect(table.rows).toEqual([
      ['a', null],
      ['b', 1],
      [null, null],
    ]);
  });

  it('turns a value it cannot draw into a blank', () => {
    const table = parseTable(tableData({ columns: ['a', 'b'], rows: [[{ nested: 1 }, [1, 2]], [Number.NaN, null]] }))!;
    expect(table.rows).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it('keeps false and zero, which are values, not blanks', () => {
    const table = parseTable(tableData({ columns: ['a', 'b'], rows: [[false, 0]] }))!;
    expect(table.rows).toEqual([[false, 0]]);
  });

  it('only believes a symbol column that exists', () => {
    expect(parseTable(tableData({ symbolColumn: 5 }))!.symbolColumn).toBeNull();
    expect(parseTable(tableData({ symbolColumn: -1 }))!.symbolColumn).toBeNull();
    expect(parseTable(tableData({ symbolColumn: 1.5 }))!.symbolColumn).toBeNull();
    expect(parseTable(tableData({ symbolColumn: null }))!.symbolColumn).toBeNull();
    expect(parseTable(tableData({ symbolColumn: '0' }))!.symbolColumn).toBeNull();
  });

  it('caps how many rows it will draw but remembers how many there were', () => {
    const rows = Array.from({ length: 9000 }, (_, i) => ['s', i]);
    const table = parseTable(tableData({ rows, totalRows: 9000 }))!;
    expect(table.rows.length).toBe(5000);
    expect(table.totalRows).toBe(9000);
  });

  it('never claims fewer total rows than it is showing', () => {
    expect(parseTable(tableData({ totalRows: 0 }))!.totalRows).toBe(1);
    expect(parseTable(tableData({ totalRows: 'many' }))!.totalRows).toBe(1);
  });

  it('keeps the decimals within reason', () => {
    expect(parseTable(tableData({ digits: 99 }))!.digits).toBe(10);
    expect(parseTable(tableData({ digits: -2 }))!.digits).toBe(0);
    expect(parseTable(tableData({ digits: 'two' }))!.digits).toBe(2);
  });

  it('treats a blank title as none', () => {
    expect(parseTable(tableData(), '   ')!.title).toBeNull();
    expect(parseTable(tableData(), null)!.title).toBeNull();
  });
});

describe('parsing a figure', () => {
  it('becomes a data URI for an image', () => {
    const figure = parseResult(event('figure', { png: PNG }, 'Plot'), 3)!;
    expect(figure).toMatchObject({ kind: 'figure', id: 3, title: 'Plot' });
    expect((figure as { src: string }).src).toBe(`data:image/png;base64,${PNG}`);
  });

  it('refuses anything that is not a base64 PNG', () => {
    for (const data of [
      null,
      {},
      { png: 5 },
      { png: '' },
      { png: 'PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+' }, // an SVG, which could carry script
      { png: '/9j/4AAQSkZJRg==' }, // a JPEG
      { png: `${PNG}"><script>alert(1)</script>` }, // not valid base64
      { png: 'iVBORw0KGgo<>' },
    ]) {
      expect(parseResult(event('figure', data), 1), JSON.stringify(data)).toBeNull();
    }
  });
});

describe('parsing a report', () => {
  const equity = { t: [1000, 2000, 3000], v: [100, 110, 121] };

  it('keeps the figures, the curves and the trades', () => {
    const report = parseReport({
      metrics: [
        { label: 'Total return', value: 21, format: 'percent' },
        { label: 'Trades', value: 4, format: 'int' },
      ],
      equity,
      benchmark: { t: [1000, 3000], v: [100, 105] },
      initialCapital: 1000,
      trades: tableData({ columns: ['symbol', 'pnl'], rows: [['p:A', 10]] }),
    })!;
    expect(report.metrics).toHaveLength(2);
    expect(report.equity).toEqual(equity);
    expect(report.benchmark!.v).toEqual([100, 105]);
    expect(report.initialCapital).toBe(1000);
    expect(report.trades!.rows).toEqual([['p:A', 10]]);
  });

  it('is happy with only an equity curve, or only trades', () => {
    expect(parseReport({ equity })!.equity).toEqual(equity);
    expect(parseReport({ trades: tableData() })!.trades).not.toBeNull();
    expect(parseReport({ metrics: [{ label: 'x', value: 1, format: 'number' }] })!.metrics).toHaveLength(1);
  });

  it('refuses a payload with nothing in it to show', () => {
    for (const data of [null, 5, 'text', {}, { metrics: [] }, { equity: null, trades: null }, { metrics: 'no' }]) {
      expect(parseReport(data), JSON.stringify(data)).toBeNull();
    }
  });

  it('drops a figure it cannot read but keeps the rest', () => {
    const report = parseReport({
      metrics: [
        { label: 'Good', value: 1, format: 'ratio' },
        { label: 'No value', value: null, format: 'money' },
        { value: 5, format: 'money' }, // no label
        'not a metric',
        { label: 'Bad number', value: 'oops', format: 'money' },
        { label: 'Odd format', value: 2, format: 'furlongs' },
      ],
      equity,
    })!;
    expect(report.metrics.map((m) => m.label)).toEqual(['Good', 'No value', 'Bad number', 'Odd format']);
    expect(report.metrics[1].value).toBeNull();
    expect(report.metrics[2].value).toBeNull();
    expect(report.metrics[3].format).toBe('number');
  });

  it('keeps a curve only where both the time and the value are usable', () => {
    const report = parseReport({
      equity: { t: [1000, 2000, 3000, 4000], v: [100, Number.NaN, 121, 130] },
    })!;
    expect(report.equity).toEqual({ t: [1000, 3000, 4000], v: [100, 121, 130] });
  });

  it('drops a curve that is too short or malformed to draw', () => {
    for (const bad of [null, {}, { t: [1], v: [1] }, { t: [1, 2] }, { t: 'a', v: 'b' }, { t: [1, 2], v: ['a', 'b'] }]) {
      expect(parseReport({ equity: bad, metrics: [{ label: 'x', value: 1, format: 'number' }] })!.equity, JSON.stringify(bad)).toBeNull();
    }
  });

  it('keeps the two arrays of a curve the same length', () => {
    const report = parseReport({ equity: { t: [1, 2, 3, 4, 5], v: [1, 2] } })!;
    expect(report.equity!.t).toHaveLength(report.equity!.v.length);
  });
});

describe('an unknown kind', () => {
  it('is refused, so a newer script cannot draw something this app does not know', () => {
    expect(parseResult(event('html', { html: '<b>hi</b>' }), 1)).toBeNull();
    expect(parseResult(event('', {}), 1)).toBeNull();
  });
});

describe('formatMetric', () => {
  const m = (value: number | string | null, format: Metric['format']): Metric => ({ label: 'x', value, format });

  it('writes money with the currency and two decimals', () => {
    expect(formatMetric(m(1234.5, 'money'))).toBe('₹1,234.50');
    expect(formatMetric(m(-1234.5, 'money'))).toBe('-₹1,234.50');
    expect(formatMetric(m(1234.5, 'money'), '$')).toBe('$1,234.50');
  });

  it('writes the other formats plainly', () => {
    expect(formatMetric(m(12.345, 'percent'))).toBe('12.35%');
    expect(formatMetric(m(1.5, 'ratio'))).toBe('1.50');
    expect(formatMetric(m(1234.6, 'int'))).toBe('1,235');
    expect(formatMetric(m(0.123456, 'number'))).toBe('0.1235');
    expect(formatMetric(m(12345.6, 'number'))).toBe('12,345.6');
    expect(formatMetric(m('ok', 'text'))).toBe('ok');
  });

  it('draws a dash for a figure that could not be worked out', () => {
    expect(formatMetric(m(null, 'money'))).toBe('—');
    expect(formatMetric(m(null, 'text'))).toBe('—');
  });
});

describe('metricTone', () => {
  const m = (label: string, value: number | string | null, format: Metric['format'] = 'money'): Metric => ({ label, value, format });

  it('reads a drawdown as a loss whichever way it is signed', () => {
    expect(metricTone(m('Max drawdown', -12, 'percent'))).toBe('loss');
    expect(metricTone(m('Max drawdown', 12, 'percent'))).toBe('loss');
    expect(metricTone(m('Max drawdown', 0, 'percent'))).toBe('');
    expect(metricTone(m('Average loss', -5))).toBe('loss');
  });

  it('goes by the sign otherwise', () => {
    expect(metricTone(m('Net profit', 100))).toBe('profit');
    expect(metricTone(m('Net profit', -100))).toBe('loss');
    expect(metricTone(m('Net profit', 0))).toBe('');
  });

  it('leaves counts, text and plain balances uncoloured', () => {
    expect(metricTone(m('Trades', 12, 'int'))).toBe('');
    expect(metricTone(m('Notes', 'fine', 'text'))).toBe('');
    expect(metricTone(m('Start equity', 1000))).toBe('');
    expect(metricTone(m('Initial capital', 1000))).toBe('');
    expect(metricTone(m('Anything', null))).toBe('');
  });
});

describe('formatCell', () => {
  it('writes numbers to the table s decimals, but whole numbers plainly', () => {
    expect(formatCell(1234.5678, 2)).toBe('1,234.57');
    expect(formatCell(1234.5678, 4)).toBe('1,234.5678');
    expect(formatCell(1234, 2)).toBe('1,234');
    expect(formatCell(0, 2)).toBe('0');
  });

  it('writes text, yes/no and blanks', () => {
    expect(formatCell('zerodha:NSE:TCS', 2)).toBe('zerodha:NSE:TCS');
    expect(formatCell(true, 2)).toBe('yes');
    expect(formatCell(false, 2)).toBe('no');
    expect(formatCell(null, 2)).toBe('');
  });
});

describe('sortRows', () => {
  const rows = [
    ['b', 2],
    ['a', 10],
    ['c', null],
    ['d', 1],
  ] as const;

  it('sorts numbers as numbers, not as text', () => {
    expect(sortRows(rows as never, 1, 'asc').map((r) => r[1])).toEqual([1, 2, 10, null]);
    expect(sortRows(rows as never, 1, 'desc').map((r) => r[1])).toEqual([10, 2, 1, null]);
  });

  it('sorts text, and keeps blanks at the bottom either way', () => {
    expect(sortRows(rows as never, 0, 'asc').map((r) => r[0])).toEqual(['a', 'b', 'c', 'd']);
    const withBlank = [['b'], [null], ['a']] as never;
    expect(sortRows(withBlank, 0, 'asc').map((r) => r[0])).toEqual(['a', 'b', null]);
    expect(sortRows(withBlank, 0, 'desc').map((r) => r[0])).toEqual(['b', 'a', null]);
  });

  it('orders symbols the way a person reads them', () => {
    const symbols = [['p:S10'], ['p:S2'], ['p:S1']] as never;
    expect(sortRows(symbols, 0, 'asc').map((r) => r[0])).toEqual(['p:S1', 'p:S2', 'p:S10']);
  });

  it('leaves the rows it was given alone', () => {
    const original = [['b'], ['a']] as never;
    sortRows(original, 0, 'asc');
    expect(original).toEqual([['b'], ['a']]);
  });
});

describe('symbolsOf', () => {
  it('collects the symbols once each', () => {
    const table = parseTable(tableData({ rows: [['p:A', 1], ['p:B', 2], ['p:A', 3]], totalRows: 3 }))!;
    expect(symbolsOf(table)).toEqual(['p:A', 'p:B']);
  });

  it('is empty without a symbol column, and skips anything that is not a symbol', () => {
    expect(symbolsOf(parseTable(tableData({ symbolColumn: null }))!)).toEqual([]);
    const odd = parseTable(tableData({ rows: [['NOTASYMBOL', 1], [null, 2], [5, 3], ['p:A', 4]], totalRows: 4 }))!;
    expect(symbolsOf(odd)).toEqual(['p:A']);
  });
});
