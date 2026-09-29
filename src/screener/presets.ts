/** Screens to start from. Each is an ordinary screen: opening one gives an unsaved copy to edit and
 *  save under the user's own name. Pure. */

import type { Condition } from '../studies/spec';
import type { ScreenSpec } from './spec';

export interface ScreenPreset {
  id: string;
  name: string;
  summary: string;
  filters: Condition[];
  columns: string[];
  sort: ScreenSpec['sort'];
}

/** ₹1 crore a day, the 50-day average of close × volume: leaves out what can hardly be traded. */
const LIQUID: Condition = { left: 'avg_traded_value_50', op: '>=', right: 1e7 };

/** Columns a new screen starts with: the day's price, move and activity. */
export const DEFAULT_COLUMNS = ['close', 'return_1', 'volume', 'rvol_20', 'avg_traded_value_50'];

export const PRESETS: readonly ScreenPreset[] = [
  {
    id: 'custom',
    name: 'Custom',
    summary: 'Every stock in the universe, with no filters yet.',
    filters: [],
    columns: DEFAULT_COLUMNS,
    sort: { column: 'return_1', descending: true },
  },
  {
    id: 'top_gainers',
    name: 'Top gainers today',
    summary: 'Liquid stocks up on the day, biggest move first.',
    filters: [{ left: 'return_1', op: '>', right: 0 }, LIQUID],
    columns: DEFAULT_COLUMNS,
    sort: { column: 'return_1', descending: true },
  },
  {
    id: 'near_high',
    name: 'Near 52-week high',
    summary: 'Within 5% of the 52-week high.',
    filters: [{ left: 'dist_high_252', op: '>=', right: -0.05 }, LIQUID],
    columns: ['close', 'return_1', 'dist_high_252', 'return_63', 'rvol_20'],
    sort: { column: 'dist_high_252', descending: true },
  },
  {
    id: 'new_high',
    name: 'New 52-week high today',
    summary: 'Closed above the highest high of the year before, today.',
    filters: [{ left: 'close', op: 'crosses_above', right: 'prior_high_252' }, LIQUID],
    columns: ['close', 'return_1', 'rvol_20', 'return_63'],
    sort: { column: 'rvol_20', descending: true },
  },
  {
    id: 'volume_spike',
    name: 'Volume spike',
    summary: 'Traded at least twice the usual volume, and closed up.',
    filters: [{ left: 'rvol_20', op: '>=', right: 2 }, { left: 'return_1', op: '>', right: 0 }, LIQUID],
    columns: ['close', 'return_1', 'volume'],
    sort: { column: 'rvol_20', descending: true },
  },
  {
    id: 'golden_cross',
    name: 'Golden cross today',
    summary: 'The 50-day SMA crossed above the 200-day SMA today.',
    filters: [{ left: 'sma_50', op: 'crosses_above', right: 'sma_200' }],
    columns: ['close', 'return_1', 'return_63'],
    sort: { column: 'return_63', descending: true },
  },
  {
    id: 'rsi_oversold',
    name: 'RSI oversold in an uptrend',
    summary: 'RSI (14) below 30 while the price is above its 200-day SMA.',
    filters: [{ left: 'rsi_14', op: '<', right: 30 }, { left: 'close', op: '>', right: 'sma_200' }, LIQUID],
    columns: ['close', 'return_1', 'dist_sma_200'],
    sort: { column: 'rsi_14', descending: false },
  },
  {
    id: 'stage_2',
    name: 'Stage 2 uptrend',
    summary: 'Price above rising 50/150/200-day averages, well off the low and near the high.',
    filters: [
      { left: 'close', op: '>', right: 'sma_50' },
      { left: 'sma_50', op: '>', right: 'sma_150' },
      { left: 'sma_150', op: '>', right: 'sma_200' },
      { left: 'slope_sma_200', op: '>', right: 0 },
      { left: 'dist_low_252', op: '>=', right: 0.3 },
      { left: 'dist_high_252', op: '>=', right: -0.25 },
      LIQUID,
    ],
    columns: ['close', 'return_1', 'return_126', 'rvol_20'],
    sort: { column: 'return_126', descending: true },
  },
];

/** A new, unsaved screen from a preset, over NSE through Zerodha (the Screener's default). */
export function fromPreset(id: string): ScreenSpec {
  const preset = PRESETS.find((p) => p.id === id) ?? PRESETS[0];
  return {
    version: 1,
    name: preset.id === 'custom' ? 'New screen' : preset.name,
    universe: { source: 'instruments', provider: 'zerodha', exchanges: ['NSE'], series: ['EQ'], watchlist: null, symbols: [], max_symbols: null },
    filters: structuredClone(preset.filters),
    columns: [...preset.columns],
    sort: preset.sort ? { ...preset.sort } : null,
    benchmark: null,
  };
}
