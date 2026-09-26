import { describe, expect, it } from 'vitest';
import engineResult from './fixtures/engine-result.json';
import { csvField, eventsCsv, metricsCsv, reportMarkdown, specJson, stocksCsv, toCsv } from './exports';
import { parseStudyResult } from './result';

const result = () => parseStudyResult(structuredClone(engineResult))!;

describe('CSV', () => {
  it('quotes what needs quoting and defuses formulas', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "x"')).toBe('"say ""x"""');
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField('-12.5')).toBe('-12.5');
    expect(csvField(-0.25)).toBe('-0.25');
    expect(csvField(null)).toBe('');
    expect(csvField(true)).toBe('true');
    expect(toCsv(['a', 'b'], [[1, null]])).toBe('a,b\r\n1,\r\n');
  });

  it('exports events, stocks and metrics', () => {
    const r = result();
    const events = eventsCsv(r).split('\r\n');
    expect(events[0].startsWith('symbol,name,event_date,')).toBe(true);
    expect(events[1].startsWith('zerodha:NSE:WIN,Winner Ltd,')).toBe(true);
    const stocks = stocksCsv(r).split('\r\n');
    expect(stocks[0].startsWith('symbol,name,events,first_event,last_event,median_event_value')).toBe(true);
    expect(stocks[1].startsWith('zerodha:NSE:WIN,Winner Ltd,1,')).toBe(true);
    const metrics = metricsCsv(r);
    expect(metrics).toContain('return_63,-63,T-3M,events,1,');
    expect(metrics).toContain('return_63,-63,T-3M,control,2,');
    expect(metrics).toContain('share: Above 200 EMA');
    expect(metrics).toContain('fwd_return_63,63,T+3M,events');
    expect(metrics.split('\r\n')[0].endsWith(',effect_or_share_diff,diff_ci_low,diff_ci_high,p,q')).toBe(true);
  });
});

describe('other exports', () => {
  it('writes the spec and a report that states its limits', () => {
    const r = result();
    expect(JSON.parse(specJson(r))).toEqual(r.spec);
    const report = reportMarkdown(r);
    expect(report).toContain('# 100% Winners');
    expect(report).toContain('1 events in 1 stocks');
    expect(report).toContain('data version');
    expect(report).toContain('do not show that any characteristic caused');
    expect(report).toContain('Market cap is not available');
  });
});
