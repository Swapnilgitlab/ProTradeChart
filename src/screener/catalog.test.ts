import { describe, expect, it } from 'vitest';
import { canonicalFeature, featureUnit } from '../studies/metrics';
import { parseCondition, withOp } from '../studies/spec';
import { chipText, compareChoices, filterValid, formatThreshold, PICKER, shortOf, titleOf, withFamily, withWindow } from './catalog';

describe('the Screener filter catalog', () => {
  it('every picker entry is a valid condition the validators accept unchanged', () => {
    for (const group of PICKER) {
      for (const entry of group.entries) {
        expect(filterValid(entry.condition), entry.label).toBe(true);
        expect(parseCondition(entry.condition), entry.label).toEqual(entry.condition);
      }
    }
  });

  it('offers what TradingView users look for', () => {
    const labels = PICKER.flatMap((g) => g.entries.map((e) => e.label));
    for (const wanted of ['Price', 'Price change (₹)', 'Change %', 'Gap up %', 'Gap down %', 'Gap %', 'Relative volume', 'Average traded value (₹)', 'RSI', 'Price vs EMA']) {
      expect(labels).toContain(wanted);
    }
  });

  it('names a filter as a chip does', () => {
    expect(chipText({ left: 'return_1', op: '>', right: 0.04 })).toBe('Chg > 4%');
    expect(chipText({ left: 'return_63', op: '>', right: 0.3 })).toBe('Perf, 3M > 30%');
    expect(chipText({ left: 'close', op: '>=', right: 'ema_50' })).toBe('Price ≥ EMA, 50');
    expect(chipText({ left: 'rsi_14@W', op: 'between', right: [40, 60] })).toBe('RSI, 14 · 1W between 40–60');
    expect(chipText({ left: 'avg_traded_value_20', op: '>', right: 1e8 })).toBe('Avg value, 20 > ₹10 Cr');
    expect(chipText({ left: 'rvol_20', op: '>', right: 1.5 })).toBe('Rel vol, 20 > 1.5×');
    expect(chipText({ left: 'close', op: '>', right: Number.NaN })).toBe('Price > …');
  });

  it('titles a feature as the editor heads it', () => {
    expect(titleOf('ema_50')).toBe('Exponential moving average');
    expect(titleOf('return_1')).toBe('Change %');
    expect(titleOf('return_63')).toBe('Performance %');
    expect(shortOf('high_252')).toBe('High, 52W');
  });

  it('formats thresholds in the feature’s unit', () => {
    expect(formatThreshold('gap_up', 0.025)).toBe('2.5%');
    expect(formatThreshold('change_1', 12.5)).toBe('12.5');
    expect(formatThreshold('volume', 2_500_000)).toBe('25 L');
  });

  it('compares a feature only with features in the same unit', () => {
    const forPrice = compareChoices('close').map((x) => x.key);
    expect(forPrice).toEqual(expect.arrayContaining(['close', 'ema', 'sma', 'high', 'prior_high']));
    expect(forPrice).not.toContain('rsi');
    for (const x of compareChoices('rsi_14')) expect(featureUnit(x.example)).toBe('number');
  });

  it('changes a family, a window or an interval without losing the rest', () => {
    expect(withFamily('ema_20@W', 'sma')).toBe('sma_20@W');
    expect(withFamily('ema_20', 'high')).toBe('high_252');
    expect(withFamily('ema_20', 'close')).toBe('close');
    expect(withWindow('rsi_14@M', 9)).toBe('rsi_9@M');
    expect(canonicalFeature(withFamily('close', 'ema'))).toBe('ema_50');
  });

  it('reshapes the right side when the operator changes', () => {
    expect(withOp({ left: 'rsi_14', op: '>', right: 40 }, 'between')).toEqual({ left: 'rsi_14', op: 'between', right: [40, 40] });
    expect(withOp({ left: 'rsi_14', op: 'between', right: [40, 60] }, '<')).toEqual({ left: 'rsi_14', op: '<', right: 40 });
    expect(withOp({ left: 'close', op: '>', right: 'ema_50' }, 'outside')).toEqual({ left: 'close', op: 'outside', right: [0, 0] });
    expect(filterValid({ left: 'rsi_14', op: 'between', right: [60, 40] })).toBe(false);
  });
});
