import { describe, expect, it } from 'vitest';
import { canonicalFeature, featureLabel, featureUnit, formatRupees, formatValue, needsBenchmark, offsetLabel, parseFeature, SUGGESTED_METRICS, windowLabel } from './metrics';

describe('the feature grammar', () => {
  it('matches the engine: canonical names, aliases and window limits', () => {
    expect(canonicalFeature('EMA_200')).toBe('ema_200');
    expect(canonicalFeature('return_12m')).toBe('return_252');
    expect(canonicalFeature('distance_from_52w_high')).toBe('dist_high_252');
    expect(canonicalFeature('relative_volume')).toBe('rvol_20');
    expect(canonicalFeature('macd_hist')).toBe('macd_hist');
    for (const bad of ['ema', 'ema_0', 'ema_1001', 'foo_20', '', 'rsi_x']) expect(canonicalFeature(bad)).toBeNull();
  });

  it('splits a name into its family and window', () => {
    expect(parseFeature('dist_sma_50')).toEqual({ family: 'dist_sma', window: 50 });
    expect(parseFeature('close')).toEqual({ family: 'close', window: null });
    expect(needsBenchmark('rs_126')).toBe(true);
    expect(needsBenchmark('return_126')).toBe(false);
  });

  it('every suggested metric is grammatical', () => {
    for (const m of SUGGESTED_METRICS) expect(canonicalFeature(m)).toBe(m);
  });
});

describe('labels and values', () => {
  it('reads windows and observation points as people say them', () => {
    expect(windowLabel(63)).toBe('3M');
    expect(windowLabel(252)).toBe('12M');
    expect(windowLabel(30)).toBe('30D');
    expect(offsetLabel(-126)).toBe('T-6M');
    expect(offsetLabel(0)).toBe('T0');
    expect(offsetLabel(63)).toBe('T+3M');
  });

  it('labels features', () => {
    expect(featureLabel('ema_200')).toBe('EMA 200');
    expect(featureLabel('return_63')).toBe('3M return');
    expect(featureLabel('dist_high_252')).toBe('Distance from 52W high');
    expect(featureLabel('dist_ema_50')).toBe('Distance from EMA 50');
    expect(featureLabel('slope_sma_200')).toBe('SMA 200 slope (1M)');
    expect(featureLabel('rvol_20')).toBe('Relative volume (20D)');
    expect(featureLabel('nonsense')).toBe('nonsense');
  });

  it('formats a value by its unit', () => {
    expect(featureUnit('return_63')).toBe('percent');
    expect(featureUnit('rvol_20')).toBe('multiple');
    expect(featureUnit('avg_traded_value_50')).toBe('money');
    expect(formatValue(0.253, 'percent')).toBe('+25.3%');
    expect(formatValue(-0.1, 'percent')).toBe('-10.0%');
    expect(formatValue(1.5, 'multiple')).toBe('1.50×');
    expect(formatValue(null, 'number')).toBe('—');
    expect(formatValue(Number.NaN, 'number')).toBe('—');
    expect(formatRupees(1.25e10)).toBe('₹1,250 Cr');
    expect(formatRupees(3.4e5)).toBe('₹3.4 L');
    expect(formatRupees(950)).toBe('₹950');
  });
});
