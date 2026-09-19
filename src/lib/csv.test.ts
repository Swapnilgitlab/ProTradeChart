import { describe, expect, it } from 'vitest';
import { detectTimeframeString, parseOhlcvCsv, parseTimestamp, sanitizeTicker } from './csv';

const local = (y: number, m: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, m - 1, d, h, mi, s).getTime();

describe('parseOhlcvCsv', () => {
  it('parses a standard daily file', () => {
    const r = parseOhlcvCsv('Date,Open,High,Low,Close,Volume\n2024-01-02,10,12,9,11,1000\n2024-01-03,11,13,10,12,1500\n');
    expect(r.error).toBeUndefined();
    expect(r.bars).toHaveLength(2);
    expect(r.bars[0]).toEqual({ time: local(2024, 1, 2), open: 10, high: 12, low: 9, close: 11, volume: 1000 });
  });

  it('sorts newest-first exports into ascending order', () => {
    const r = parseOhlcvCsv('date,open,high,low,close\n2024-01-03,1,1,1,1\n2024-01-02,2,2,2,2\n');
    expect(r.bars.map((b) => b.close)).toEqual([2, 1]);
  });

  it('detects semicolon delimiters and decimal commas', () => {
    const r = parseOhlcvCsv('time;open;high;low;close\n2024-01-02;10,5;12,25;9,75;11,0\n');
    expect(r.bars[0]).toMatchObject({ open: 10.5, high: 12.25, low: 9.75, close: 11 });
  });

  it('handles quoted fields, thousands separators and a BOM', () => {
    const r = parseOhlcvCsv('\uFEFF"Date","Open","High","Low","Close"\n"2024-01-02","1,234.50","1,300.00","1,200.00","1,250.25"\n');
    expect(r.error).toBeUndefined();
    expect(r.bars[0]).toMatchObject({ open: 1234.5, high: 1300, low: 1200, close: 1250.25 });
  });

  it('prefers "close" over "adj close" and works without a volume column', () => {
    const r = parseOhlcvCsv('date,open,high,low,adj close,close\n2024-01-02,1,2,1,1.5,1.9\n');
    expect(r.bars[0].close).toBe(1.9);
    expect(r.bars[0].volume).toBeUndefined();
  });

  it('skips bad rows with a warning but keeps the good ones', () => {
    const r = parseOhlcvCsv(
      ['date,open,high,low,close', '2024-01-02,1,2,1,2', 'not-a-date,1,2,1,2', '2024-01-04,x,2,1,2', '2024-01-05,0,2,1,2', '2024-01-06,3,4,3,4'].join('\n'),
    );
    expect(r.bars).toHaveLength(2);
    expect(r.rowsSkipped).toBe(3);
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings[0]).toContain('Line 3');
  });

  it('repairs a high/low that does not bound the open and close', () => {
    const r = parseOhlcvCsv('date,open,high,low,close\n2024-01-02,10,9,11,12\n');
    expect(r.bars[0].high).toBe(12);
    expect(r.bars[0].low).toBe(9);
  });

  it('reports missing columns and empty input as errors', () => {
    expect(parseOhlcvCsv('date,open,high\n2024-01-02,1,2\n').error).toMatch(/low, close/);
    expect(parseOhlcvCsv('date,open,high,low,close\n').error).toMatch(/header row/);
    expect(parseOhlcvCsv('date,open,high,low,close\nfoo,1,2,1,2\n').error).toMatch(/No usable rows/);
  });

  it('accepts CRLF line endings', () => {
    expect(parseOhlcvCsv('date,open,high,low,close\r\n2024-01-02,1,2,1,2\r\n').bars).toHaveLength(1);
  });
});

describe('parseTimestamp', () => {
  it('reads epoch seconds and milliseconds', () => {
    expect(parseTimestamp('1704153600')).toBe(1704153600 * 1000);
    expect(parseTimestamp('1704153600000')).toBe(1704153600000);
  });

  it('reads compact YYYYMMDD dates in local time', () => {
    expect(parseTimestamp('20240102')).toBe(local(2024, 1, 2));
  });

  it('reads ISO-like dates and datetimes without a zone as local time', () => {
    expect(parseTimestamp('2024-01-02')).toBe(local(2024, 1, 2));
    expect(parseTimestamp('2024-01-02 09:15')).toBe(local(2024, 1, 2, 9, 15));
    expect(parseTimestamp('2024-01-02T09:15:30')).toBe(local(2024, 1, 2, 9, 15, 30));
    expect(parseTimestamp('2024/01/02')).toBe(local(2024, 1, 2));
  });

  it('honours an explicit timezone', () => {
    expect(parseTimestamp('2024-01-02T09:15:00Z')).toBe(Date.UTC(2024, 0, 2, 9, 15));
    expect(parseTimestamp('2024-01-02T09:15:00+05:30')).toBe(Date.UTC(2024, 0, 2, 3, 45));
  });

  it('reads day-first and month-first slash dates per the given order', () => {
    expect(parseTimestamp('03/04/2024', 'dmy')).toBe(local(2024, 4, 3));
    expect(parseTimestamp('03/04/2024', 'mdy')).toBe(local(2024, 3, 4));
    expect(parseTimestamp('15-01-24', 'dmy')).toBe(local(2024, 1, 15));
  });

  it('rejects impossible dates and garbage', () => {
    expect(parseTimestamp('2024-02-31')).toBeNull();
    expect(parseTimestamp('hello')).toBeNull();
    expect(parseTimestamp('')).toBeNull();
  });

  it('infers day-first from a value that can only be a day', () => {
    const r = parseOhlcvCsv('date,open,high,low,close\n25/12/2024,1,1,1,1\n03/01/2025,2,2,2,2\n');
    expect(r.bars[0].time).toBe(local(2024, 12, 25));
    expect(r.bars[1].time).toBe(local(2025, 1, 3));
  });
});

describe('detectTimeframeString', () => {
  const series = (stepMs: number, n = 20) => Array.from({ length: n }, (_, i) => i * stepMs);
  const MIN = 60_000;
  const DAY = 86_400_000;

  it('recognises intraday, daily, weekly and monthly spacing', () => {
    expect(detectTimeframeString(series(MIN))).toBe('1');
    expect(detectTimeframeString(series(5 * MIN))).toBe('5');
    expect(detectTimeframeString(series(60 * MIN))).toBe('60');
    expect(detectTimeframeString(series(DAY))).toBe('D');
    expect(detectTimeframeString(series(7 * DAY))).toBe('W');
    expect(detectTimeframeString(series(31 * DAY))).toBe('M');
  });

  it('uses the median gap so overnight and weekend gaps do not skew it', () => {
    const times: number[] = [];
    for (let day = 0; day < 5; day++) for (let i = 0; i < 6; i++) times.push(day * DAY + i * 15 * MIN);
    expect(detectTimeframeString(times)).toBe('15');
  });

  it('falls back to daily for a single bar', () => {
    expect(detectTimeframeString([0])).toBe('D');
  });
});

describe('sanitizeTicker', () => {
  it('drops the extension and normalises characters', () => {
    expect(sanitizeTicker('my data.csv')).toBe('MY_DATA');
    expect(sanitizeTicker('  eurusd-1h.TXT ')).toBe('EURUSD-1H');
    expect(sanitizeTicker('BRK.B')).toBe('BRK.B');
    expect(sanitizeTicker('***')).toBe('');
  });
});
