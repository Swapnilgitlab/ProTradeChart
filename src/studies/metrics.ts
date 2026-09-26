/** The feature grammar a Study is written in: `return_252`, `ema_200`, `rsi_14`, `dist_high_252`.
 *
 *  The Python engine computes these (`python/protrade/features.py`) and this file must accept exactly
 *  the same names — same families, same aliases, same window limits — so the builder never saves a
 *  spec the engine refuses. Here they are also labelled and given a unit, for display. Pure. */

export const PLAIN = ['open', 'high', 'low', 'close', 'volume', 'macd', 'macd_signal', 'macd_hist'] as const;

export const FAMILIES = [
  'return',
  'gain_from_low',
  'sma',
  'ema',
  'dist_sma',
  'dist_ema',
  'slope_sma',
  'slope_ema',
  'rsi',
  'atr',
  'atr_pct',
  'high',
  'low',
  'prior_high',
  'prior_low',
  'dist_high',
  'dist_low',
  'range',
  'avg_volume',
  'rvol',
  'avg_traded_value',
  'volatility',
  'drawdown',
  'max_drawdown',
  'rs',
  'adx',
  'bb_pctb',
  'bb_width',
  'stoch_k',
  'stoch_d',
] as const;

export type Family = (typeof FAMILIES)[number];

export const ALIASES: Record<string, string> = {
  return_1d: 'return_1',
  return_5d: 'return_5',
  return_1m: 'return_21',
  return_3m: 'return_63',
  return_6m: 'return_126',
  return_12m: 'return_252',
  high_52w: 'high_252',
  low_52w: 'low_252',
  distance_from_52w_high: 'dist_high_252',
  distance_from_52w_low: 'dist_low_252',
  relative_volume: 'rvol_20',
  relative_volume_20: 'rvol_20',
  relative_volume_50: 'rvol_50',
  drawdown_from_high: 'drawdown_252',
  relative_strength_vs_index: 'rs_126',
};

export const MAX_WINDOW = 1000;

/** How a feature's value reads: a fraction shown as a percentage, a price, a plain number, a
 *  multiple (relative volume), shares, or rupees traded. */
export type Unit = 'percent' | 'price' | 'number' | 'multiple' | 'volume' | 'money';

const FAMILY_UNIT: Record<Family, Unit> = {
  return: 'percent',
  gain_from_low: 'percent',
  sma: 'price',
  ema: 'price',
  dist_sma: 'percent',
  dist_ema: 'percent',
  slope_sma: 'percent',
  slope_ema: 'percent',
  rsi: 'number',
  atr: 'price',
  atr_pct: 'percent',
  high: 'price',
  low: 'price',
  prior_high: 'price',
  prior_low: 'price',
  dist_high: 'percent',
  dist_low: 'percent',
  range: 'percent',
  avg_volume: 'volume',
  rvol: 'multiple',
  avg_traded_value: 'money',
  volatility: 'percent',
  drawdown: 'percent',
  max_drawdown: 'percent',
  rs: 'percent',
  adx: 'number',
  bb_pctb: 'number',
  bb_width: 'percent',
  stoch_k: 'number',
  stoch_d: 'number',
};

const PLAIN_UNIT: Record<(typeof PLAIN)[number], Unit> = {
  open: 'price',
  high: 'price',
  low: 'price',
  close: 'price',
  volume: 'volume',
  macd: 'percent',
  macd_signal: 'percent',
  macd_hist: 'percent',
};

const FAMILY_LABEL: Record<Family, string> = {
  return: 'return',
  gain_from_low: 'gain from low',
  sma: 'SMA',
  ema: 'EMA',
  dist_sma: 'distance from SMA',
  dist_ema: 'distance from EMA',
  slope_sma: 'SMA slope (1M)',
  slope_ema: 'EMA slope (1M)',
  rsi: 'RSI',
  atr: 'ATR',
  atr_pct: 'ATR % of price',
  high: 'high',
  low: 'low',
  prior_high: 'prior high',
  prior_low: 'prior low',
  dist_high: 'distance from high',
  dist_low: 'distance from low',
  range: 'range',
  avg_volume: 'average volume',
  rvol: 'relative volume',
  avg_traded_value: 'average traded value',
  volatility: 'volatility',
  drawdown: 'drawdown',
  max_drawdown: 'max drawdown',
  rs: 'relative strength',
  adx: 'ADX',
  bb_pctb: 'Bollinger %B',
  bb_width: 'Bollinger width',
  stoch_k: 'Stochastic %K',
  stoch_d: 'Stochastic %D',
};

const PLAIN_LABEL: Record<(typeof PLAIN)[number], string> = {
  open: 'Open',
  high: 'High',
  low: 'Low',
  close: 'Close',
  volume: 'Volume',
  macd: 'MACD (% of price)',
  macd_signal: 'MACD signal (% of price)',
  macd_hist: 'MACD histogram (% of price)',
};

const NAME = /^([a-z_]+?)_(\d+)$/;

/** The canonical spelling of a feature name, or null when the grammar doesn't know it. */
export function canonicalFeature(name: string): string | null {
  const key = ALIASES[name.trim().toLowerCase()] ?? name.trim().toLowerCase();
  if ((PLAIN as readonly string[]).includes(key)) return key;
  const match = NAME.exec(key);
  if (!match || !(FAMILIES as readonly string[]).includes(match[1])) return null;
  const n = Number(match[2]);
  return n >= 1 && n <= MAX_WINDOW ? `${match[1]}_${n}` : null;
}

export interface ParsedFeature {
  family: Family | (typeof PLAIN)[number];
  window: number | null;
}

export function parseFeature(name: string): ParsedFeature | null {
  const key = canonicalFeature(name);
  if (key === null) return null;
  if ((PLAIN as readonly string[]).includes(key)) return { family: key as (typeof PLAIN)[number], window: null };
  const i = key.lastIndexOf('_');
  return { family: key.slice(0, i) as Family, window: Number(key.slice(i + 1)) };
}

export const needsBenchmark = (name: string) => parseFeature(name)?.family === 'rs';

export function featureUnit(name: string): Unit {
  const parsed = parseFeature(name);
  if (!parsed) return 'number';
  return parsed.window === null ? PLAIN_UNIT[parsed.family as (typeof PLAIN)[number]] : FAMILY_UNIT[parsed.family as Family];
}

/** A window in bars as people say it: 21 → 1M, 63 → 3M, 252 → 12M; anything else in days. */
export function windowLabel(bars: number): string {
  const months: Record<number, string> = { 5: '1W', 10: '2W', 21: '1M', 42: '2M', 63: '3M', 126: '6M', 189: '9M', 252: '12M', 504: '24M', 756: '36M' };
  return months[bars] ?? `${bars}D`;
}

/** An observation point: `T-3M`, `T0`, `T+6M`. */
export function offsetLabel(offset: number): string {
  if (offset === 0) return 'T0';
  return `T${offset < 0 ? '-' : '+'}${windowLabel(Math.abs(offset))}`;
}

/** A feature as a person reads it: `ema_200` → "EMA 200", `return_63` → "3M return",
 *  `dist_high_252` → "Distance from 12M high". */
export function featureLabel(name: string): string {
  const parsed = parseFeature(name);
  if (!parsed) return name;
  if (parsed.window === null) return PLAIN_LABEL[parsed.family as (typeof PLAIN)[number]];
  const n = parsed.window;
  const family = parsed.family as Family;
  const w = windowLabel(n);
  switch (family) {
    case 'sma':
    case 'ema':
    case 'rsi':
    case 'atr':
    case 'adx':
      return `${FAMILY_LABEL[family]} ${n}`;
    case 'dist_sma':
    case 'dist_ema':
      return `Distance from ${family === 'dist_sma' ? 'SMA' : 'EMA'} ${n}`;
    case 'slope_sma':
    case 'slope_ema':
      return `${family === 'slope_sma' ? 'SMA' : 'EMA'} ${n} slope (1M)`;
    case 'high':
    case 'low':
      return `${w === '12M' ? '52W' : w} ${family}`;
    case 'dist_high':
    case 'dist_low':
      return `Distance from ${w === '12M' ? '52W' : w} ${family === 'dist_high' ? 'high' : 'low'}`;
    case 'rvol':
      return `Relative volume (${n}D)`;
    default:
      return `${w} ${FAMILY_LABEL[family]}`;
  }
}



/** A value of a feature as text. Fractions become percentages; rupee amounts are shortened to
 *  crore / lakh, the units Indian markets are read in. */
export function formatValue(value: number | null | undefined, unit: Unit, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  switch (unit) {
    case 'percent':
      return `${value > 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`;
    case 'multiple':
      return `${value.toFixed(2)}×`;
    case 'money':
      return formatRupees(value);
    case 'volume':
      return Math.round(value).toLocaleString('en-IN');
    case 'price':
      return value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    default:
      return value.toFixed(digits);
  }
}

/** ₹12.3 Cr, ₹45.6 L, ₹950 — crore is 10⁷, lakh 10⁵. */
export function formatRupees(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toLocaleString('en-IN', { maximumFractionDigits: abs >= 1e9 ? 0 : 1 })} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toLocaleString('en-IN', { maximumFractionDigits: 1 })} L`;
  return `${sign}₹${Math.round(abs).toLocaleString('en-IN')}`;
}

/** Features offered in the builder's picker, in a sensible order. Any grammatical name can still be typed. */
export const SUGGESTED_METRICS: readonly string[] = [
  'return_21',
  'return_63',
  'return_126',
  'return_252',
  'rsi_14',
  'atr_pct_14',
  'ema_20',
  'ema_50',
  'ema_100',
  'ema_200',
  'dist_ema_50',
  'dist_ema_200',
  'slope_sma_200',
  'dist_high_252',
  'dist_low_252',
  'rvol_20',
  'rvol_50',
  'avg_traded_value_50',
  'volatility_20',
  'volatility_63',
  'drawdown_252',
  'max_drawdown_252',
  'range_63',
  'macd_hist',
  'adx_14',
  'bb_width_20',
  'stoch_k_14',
  'rs_126',
];
