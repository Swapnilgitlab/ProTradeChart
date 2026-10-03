/** What the Screener's filter editor offers: the features grouped as a picker (Price, Volume, Moving
 *  averages…), each family's title and short chip text, how its window is chosen (a length like 14 or
 *  50, or a period like 1 day or 3 months), and which other features a filter can compare it with.
 *  Every name here is in the Studies' feature grammar (`studies/metrics.ts`). Pure. */

import { canonicalFeature, featureUnit, INTERVAL_LABELS, parseFeature, windowLabel, withInterval, type Family, type Interval, type PLAIN } from '../studies/metrics';
import type { Condition, Op } from '../studies/spec';

type Key = Family | (typeof PLAIN)[number];

export type Param = 'length' | 'period' | null;

interface FamilyInfo {
  title: string;
  /** The chip's text, before its window: `EMA` becomes `EMA, 50`. */
  short: string;
  param: Param;
}

const INFO: Record<Key, FamilyInfo> = {
  close: { title: 'Price', short: 'Price', param: null },
  open: { title: 'Open', short: 'Open', param: null },
  high: { title: 'High', short: 'High', param: 'period' },
  low: { title: 'Low', short: 'Low', param: 'period' },
  volume: { title: 'Volume', short: 'Vol', param: null },
  change: { title: 'Price change', short: 'Chg ₹', param: 'period' },
  return: { title: 'Change %', short: 'Chg', param: 'period' },
  gap: { title: 'Gap %', short: 'Gap', param: null },
  gap_up: { title: 'Gap up %', short: 'Gap up', param: null },
  gap_down: { title: 'Gap down %', short: 'Gap down', param: null },
  prior_high: { title: 'Previous high', short: 'Prev high', param: 'period' },
  prior_low: { title: 'Previous low', short: 'Prev low', param: 'period' },
  dist_high: { title: 'Distance from high', short: 'From high', param: 'period' },
  dist_low: { title: 'Distance from low', short: 'From low', param: 'period' },
  range: { title: 'Range (high vs low)', short: 'Range', param: 'period' },
  avg_volume: { title: 'Average volume', short: 'Avg vol', param: 'length' },
  rvol: { title: 'Relative volume', short: 'Rel vol', param: 'length' },
  avg_traded_value: { title: 'Average traded value (₹)', short: 'Avg value', param: 'length' },
  sma: { title: 'Simple moving average', short: 'SMA', param: 'length' },
  ema: { title: 'Exponential moving average', short: 'EMA', param: 'length' },
  dist_sma: { title: 'Distance from SMA', short: 'From SMA', param: 'length' },
  dist_ema: { title: 'Distance from EMA', short: 'From EMA', param: 'length' },
  slope_sma: { title: 'SMA slope (1 month)', short: 'SMA slope', param: 'length' },
  slope_ema: { title: 'EMA slope (1 month)', short: 'EMA slope', param: 'length' },
  rsi: { title: 'Relative strength index', short: 'RSI', param: 'length' },
  stoch_k: { title: 'Stochastic %K', short: 'Stoch %K', param: 'length' },
  stoch_d: { title: 'Stochastic %D', short: 'Stoch %D', param: 'length' },
  macd: { title: 'MACD (% of price)', short: 'MACD', param: null },
  macd_signal: { title: 'MACD signal (% of price)', short: 'MACD sig', param: null },
  macd_hist: { title: 'MACD histogram (% of price)', short: 'MACD hist', param: null },
  adx: { title: 'ADX', short: 'ADX', param: 'length' },
  bb_pctb: { title: 'Bollinger %B', short: 'BB %B', param: 'length' },
  bb_width: { title: 'Bollinger width', short: 'BB width', param: 'length' },
  gain_from_low: { title: 'Gain from low', short: 'From low ↑', param: 'period' },
  drawdown: { title: 'Drawdown from high', short: 'Drawdown', param: 'period' },
  max_drawdown: { title: 'Max drawdown', short: 'Max DD', param: 'period' },
  rs: { title: 'Relative strength vs index', short: 'RS', param: 'period' },
  atr: { title: 'Average true range', short: 'ATR', param: 'length' },
  atr_pct: { title: 'ATR % of price', short: 'ATR %', param: 'length' },
  volatility: { title: 'Volatility (annualised)', short: 'Volatility', param: 'period' },
};

export interface PickerEntry {
  label: string;
  /** The filter a pick adds. */
  condition: Condition;
}

export interface PickerGroup {
  category: string;
  entries: PickerEntry[];
}

const pick = (label: string, left: string, op: Op, right: Condition['right']): PickerEntry => ({ label, condition: { left, op, right } });

/** The add-filter menu, grouped like TradingView's. */
export const PICKER: readonly PickerGroup[] = [
  {
    category: 'Price',
    entries: [
      pick('Price', 'close', '>', 100),
      pick('Price change (₹)', 'change_1', '>', 0),
      pick('Change %', 'return_1', '>', 0.02),
      pick('Gap %', 'gap', '>', 0.01),
      pick('Gap up %', 'gap_up', '>=', 0.02),
      pick('Gap down %', 'gap_down', '>=', 0.02),
      pick('Price vs 52-week high', 'close', '>=', 'prior_high_252'),
      pick('Distance from 52-week high', 'dist_high_252', '>=', -0.05),
      pick('Distance from 52-week low', 'dist_low_252', '>=', 0.3),
      pick('Open', 'open', '>', 100),
    ],
  },
  {
    category: 'Volume',
    entries: [
      pick('Volume', 'volume', '>', 1e6),
      pick('Relative volume', 'rvol_20', '>', 1.5),
      pick('Average volume', 'avg_volume_20', '>', 5e5),
      pick('Average traded value (₹)', 'avg_traded_value_20', '>', 1e8),
    ],
  },
  {
    category: 'Moving averages',
    entries: [
      pick('Price vs EMA', 'close', '>=', 'ema_50'),
      pick('Price vs SMA', 'close', '>=', 'sma_200'),
      pick('EMA crossover', 'ema_20', 'crosses_above', 'ema_50'),
      pick('SMA crossover', 'sma_50', 'crosses_above', 'sma_200'),
      pick('Distance from EMA', 'dist_ema_50', '>', 0),
      pick('Distance from SMA', 'dist_sma_200', '>', 0),
      pick('SMA slope', 'slope_sma_200', '>', 0),
    ],
  },
  {
    category: 'Oscillators',
    entries: [
      pick('RSI', 'rsi_14', '>', 60),
      pick('Stochastic %K', 'stoch_k_14', '<', 20),
      pick('MACD histogram', 'macd_hist', 'crosses_above', 0),
      pick('ADX', 'adx_14', '>', 25),
      pick('Bollinger %B', 'bb_pctb_20', '>', 1),
      pick('Bollinger width', 'bb_width_20', '<', 0.1),
    ],
  },
  {
    category: 'Performance',
    entries: [
      pick('Performance %', 'return_63', '>', 0.3),
      pick('Gain from 52-week low', 'gain_from_low_252', '>', 0.5),
      pick('Drawdown from high', 'drawdown_252', '>', -0.1),
      pick('Relative strength vs index', 'rs_126', '>', 0),
    ],
  },
  {
    category: 'Volatility',
    entries: [
      pick('ATR % of price', 'atr_pct_14', '<', 0.03),
      pick('ATR', 'atr_14', '>', 10),
      pick('Volatility', 'volatility_21', '<', 0.3),
      pick('Range', 'range_63', '<', 0.2),
    ],
  },
];

/** Lengths offered for an indicator's window; the feature's own is always offered too. */
export const LENGTHS = [5, 9, 10, 14, 20, 21, 26, 50, 100, 150, 200] as const;

/** Periods offered for a window that is a span of time. */
export const PERIODS: readonly [number, string][] = [
  [1, '1 day'],
  [5, '1 week'],
  [10, '2 weeks'],
  [21, '1 month'],
  [42, '2 months'],
  [63, '3 months'],
  [126, '6 months'],
  [189, '9 months'],
  [252, '12 months'],
  [504, '24 months'],
];

const PERIOD_SHORT: Record<number, string> = { 1: '1D', 5: '1W', 10: '2W', 21: '1M', 42: '2M', 63: '3M', 126: '6M', 189: '9M', 252: '52W', 504: '24M' };

function info(name: string): { key: Key; window: number | null; interval: Interval } | null {
  const parsed = parseFeature(name);
  return parsed ? { key: parsed.family, window: parsed.window, interval: parsed.interval } : null;
}

/** How a feature's window is chosen in the editor. */
export const paramOf = (name: string): Param => {
  const f = info(name);
  return f ? INFO[f.key].param : null;
};

/** The editor's heading: "Exponential moving average", "Change %" (one day) or "Performance". */
export function titleOf(name: string): string {
  const f = info(name);
  if (!f) return name;
  if (f.key === 'return' && f.window !== 1) return 'Performance %';
  return INFO[f.key].title;
}

/** A feature as a chip says it: "EMA, 50", "Chg", "Perf, 3M", "RSI, 14 · 1W". */
export function shortOf(name: string): string {
  const f = info(name);
  if (!f) return name;
  let text = INFO[f.key].short;
  if (f.key === 'return' && f.window !== 1) text = 'Perf';
  if (f.window !== null && !(f.key === 'return' && f.window === 1)) {
    text += `, ${INFO[f.key].param === 'period' ? (PERIOD_SHORT[f.window] ?? windowLabel(f.window)) : f.window}`;
  }
  return f.interval === 'D' ? text : `${text} · 1${f.interval}`;
}

const OP_SYMBOL: Record<Op, string> = {
  '>': '>',
  '>=': '≥',
  '<': '<',
  '<=': '≤',
  crosses_above: 'crosses ↑',
  crosses_below: 'crosses ↓',
  between: 'between',
  outside: 'outside',
};

/** A threshold in the feature's own unit, as typed: 4% for 0.04, ₹1 Cr for 1e7, 1.5× for a multiple. */
export function formatThreshold(name: string, value: number): string {
  if (!Number.isFinite(value)) return '…';
  switch (featureUnit(name)) {
    case 'percent':
      return `${Number((value * 100).toPrecision(6))}%`;
    case 'multiple':
      return `${value}×`;
    case 'money':
      return value >= 1e7 ? `₹${Number((value / 1e7).toPrecision(4))} Cr` : value >= 1e5 ? `₹${Number((value / 1e5).toPrecision(4))} L` : `₹${value}`;
    case 'volume':
      return value >= 1e7 ? `${Number((value / 1e7).toPrecision(4))} Cr` : value >= 1e5 ? `${Number((value / 1e5).toPrecision(4))} L` : String(value);
    default:
      return String(value);
  }
}

/** A filter as its chip reads: "Chg > 2%", "Price ≥ EMA, 50", "RSI, 14 between 40–60". */
export function chipText(c: Condition): string {
  const right = Array.isArray(c.right)
    ? `${formatThreshold(c.left, c.right[0])}–${formatThreshold(c.left, c.right[1])}`
    : typeof c.right === 'string'
      ? shortOf(c.right)
      : formatThreshold(c.left, c.right);
  return `${shortOf(c.left)} ${OP_SYMBOL[c.op]} ${right}`;
}

/** The unit suffix a value is typed with. */
export function valueSuffix(name: string): string {
  switch (featureUnit(name)) {
    case 'percent':
      return '%';
    case 'multiple':
      return '×';
    case 'money':
    case 'price':
      return '₹';
    default:
      return '';
  }
}

/** How a typed value maps to the stored one: percentages are typed as percentages. */
export const valueScale = (name: string) => (featureUnit(name) === 'percent' ? 100 : 1);

/** Families a filter can be compared with: those in the same unit, the price first. */
export function compareChoices(left: string): { key: string; title: string; example: string }[] {
  const unit = featureUnit(left);
  return (Object.keys(INFO) as Key[])
    .map((key) => ({ key, example: exampleOf(key) }))
    .filter(({ example }) => featureUnit(example) === unit)
    .map(({ key, example }) => ({ key, title: INFO[key].title, example }));
}

const DEFAULT_WINDOW: Partial<Record<Key, number>> = { sma: 50, ema: 50, rsi: 14, adx: 14, atr: 14, atr_pct: 14, stoch_k: 14, stoch_d: 14, bb_pctb: 20, bb_width: 20, rvol: 20, avg_volume: 20, avg_traded_value: 20, return: 1, change: 1 };

/** A feature of a family with its usual window (`ema` → `ema_50`, `high` → `high_252`). */
export function exampleOf(key: string): string {
  const k = key as Key;
  if (INFO[k]?.param === null) return k;
  const n = DEFAULT_WINDOW[k] ?? (INFO[k]?.param === 'period' ? 252 : 14);
  return `${k}_${n}`;
}

/** `name` with another family, keeping its window where the new family has one, and its interval. */
export function withFamily(name: string, key: string): string {
  const f = info(name);
  const k = key as Key;
  if (!INFO[k]) return name;
  const interval = f?.interval ?? 'D';
  const keepWindow = f && f.window !== null && INFO[k].param !== null && INFO[f.key].param === INFO[k].param;
  const base = keepWindow ? `${k}_${f.window}` : exampleOf(k);
  return withInterval(base, interval);
}

/** `name` with another window. */
export function withWindow(name: string, window: number): string {
  const f = info(name);
  if (!f || f.window === null) return name;
  return withInterval(`${f.key}_${window}`, f.interval);
}

export const familyOf = (name: string): string | null => info(name)?.key ?? null;
export const windowOf = (name: string): number | null => info(name)?.window ?? null;
export const intervalOf = (name: string): Interval => info(name)?.interval ?? 'D';
export { INTERVAL_LABELS };

/** Whether a filter can run: known features, and a finite number (or range) where one is typed. */
export function filterValid(c: Condition): boolean {
  if (!canonicalFeature(c.left)) return false;
  if (Array.isArray(c.right)) return c.right.every(Number.isFinite) && c.right[0] <= c.right[1];
  return typeof c.right === 'string' ? canonicalFeature(c.right) !== null : Number.isFinite(c.right);
}
