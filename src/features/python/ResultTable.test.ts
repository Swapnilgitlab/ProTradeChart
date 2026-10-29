import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TableResult } from '../../python/results';
import { ResultTable } from './ResultTable';

const table = (rows: TableResult['rows']): TableResult => ({
  kind: 'table',
  id: 1,
  title: 'Screen',
  columns: ['symbol', 'close'],
  rows,
  totalRows: rows.length,
  symbolColumn: 0,
  digits: 2,
});

const render = (t: TableResult) => renderToStaticMarkup(createElement(ResultTable, { table: t, onOpenSymbol: () => {} }));

describe('ResultTable symbol cells', () => {
  it('read as the ticker alone: no data source and no usual exchange', () => {
    const html = render(table([['india:NSE:HFCL', 211.27], ['india:NSE:RELIANCE', 1226]]));
    expect(html).toContain('>HFCL<');
    expect(html).toContain('>RELIANCE<');
    expect(html).not.toContain('>india:');
    expect(html).not.toContain('>NSE:');
  });

  it('keep an exchange that tells two instruments apart', () => {
    expect(render(table([['india:BSE:RELIANCE', 1]]))).toContain('>BSE:RELIANCE<');
  });

  it('still open the full symbol, which is what the hover text names', () => {
    expect(render(table([['india:NSE:HFCL', 1]]))).toContain('title="Open india:NSE:HFCL"');
  });

  it('leave a column of plain values alone', () => {
    const html = render({ ...table([['HFCL', 1]]), symbolColumn: null });
    expect(html).toContain('HFCL');
    expect(html).not.toContain('python-symbol');
  });
});
