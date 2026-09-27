/** What the Study Results page derives from a result for display: which columns to show at an
 *  observation point, before/after pairs, liquidity buckets, one event's measurements. The
 *  numbers themselves come from the engine; this only arranges them. Pure. */

import type { Cell } from '../python/results';
import { measureUnit, type MeasureUnit } from './measures';
import { featureUnit, type Unit } from './metrics';
import type { Stat, StudyResultData } from './result';
import { measureColumn, metricColumn } from './spec';

export interface TableColumn {
  key: string;
  index: number;
  metric: string | null;
  unit: Unit | MeasureUnit | 'date' | 'text' | 'symbol';
  /** For a measure's column: its index in the spec, and where the row's status is (shown when there is no value). */
  measure?: { index: number; statusIndex: number };
}

/** Why a measure has no value for an event, in a word or two. */
export const STATUS_WORD: Record<string, string> = {
  never: 'never',
  too_recent: 'too recent',
  no_history: 'no history',
  not_found: 'not found',
  empty: 'empty window',
};

/** The event table's columns for the measures: each one's value and, for a window with a found
 *  endpoint, the day it began. */
export function measureColumns(result: StudyResultData): TableColumn[] {
  const at = (key: string) => result.events.columns.indexOf(key);
  const out: TableColumn[] = [];
  result.spec.measures.forEach((m, k) => {
    const index = at(measureColumn(k));
    if (index < 0) return;
    out.push({ key: measureColumn(k), index, metric: null, unit: measureUnit(m), measure: { index: k, statusIndex: at(measureColumn(k, 'status')) } });
    const from = at(measureColumn(k, 'from'));
    if (from >= 0) out.push({ key: measureColumn(k, 'from'), index: from, metric: null, unit: 'date' });
  });
  return out;
}

const BASE: Record<string, TableColumn['unit']> = {
  symbol: 'symbol',
  name: 'text',
  event_date: 'date',
  price: 'price',
  market_cap: 'money',
  avg_traded_value: 'money',
};

/** The event table's columns at one observation point: who and when, the event's value, then each
 *  metric there, then the forward returns. */
export function eventColumns(result: StudyResultData, offset: number): TableColumn[] {
  const at = (key: string) => result.events.columns.indexOf(key);
  const out: TableColumn[] = [];
  for (const key of ['symbol', 'name', 'event_date', 'price', 'market_cap', 'avg_traded_value']) {
    if (at(key) >= 0) out.push({ key, index: at(key), metric: null, unit: BASE[key] });
  }
  const first = result.spec.event.conditions[0]?.left;
  if (at('event_value') >= 0 && first) out.splice(3, 0, { key: 'event_value', index: at('event_value'), metric: first, unit: featureUnit(first) });
  for (const metric of result.spec.metrics) {
    const key = metricColumn(metric, offset);
    if (at(key) >= 0) out.push({ key, index: at(key), metric, unit: featureUnit(metric) });
  }
  for (const w of result.spec.forward_windows) {
    const key = `fwd_return_${w}`;
    if (at(key) >= 0) out.push({ key, index: at(key), metric: key, unit: 'percent' });
  }
  out.push(...measureColumns(result));
  return out;
}

/** The event rows with their index, sorted by one column (blanks last, whichever way), or in the
 *  engine's order when `sort` is null. Shared by every event table. */
export function sortRows(result: StudyResultData, sort: { key: string; dir: 1 | -1 } | null): { row: Cell[]; i: number }[] {
  const indexed = result.events.rows.map((row, i) => ({ row, i }));
  if (!sort) return indexed;
  const at = result.events.columns.indexOf(sort.key);
  if (at < 0) return indexed;
  return indexed.sort((a, b) => {
    const x = a.row[at];
    const y = b.row[at];
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sort.dir;
  });
}

/** Observation points with a matching one on the other side (T-3M and T+3M), for before/after. */
export function beforeAfterWindows(result: StudyResultData): number[] {
  const offsets = new Set(result.offsets);
  return result.offsets.filter((o) => o > 0 && offsets.has(-o));
}

export interface LiquidityBucket {
  label: string;
  events: number;
  /** Median forward return per forward window, in the spec's order. */
  forward: (number | null)[];
}

const BUCKETS: { label: string; below: number }[] = [
  { label: 'Under ₹1 Cr a day', below: 1e7 },
  { label: '₹1–10 Cr a day', below: 1e8 },
  { label: '₹10–100 Cr a day', below: 1e9 },
  { label: 'Over ₹100 Cr a day', below: Number.POSITIVE_INFINITY },
];

/** Events grouped by their average traded value at the event — a size proxy the data really has,
 *  shown in place of the market-cap buckets it doesn't. */
export function liquidityBuckets(result: StudyResultData): LiquidityBucket[] {
  const at = result.events.columns.indexOf('avg_traded_value');
  if (at < 0) return [];
  const fwd = result.spec.forward_windows.map((w) => result.events.columns.indexOf(`fwd_return_${w}`));
  const groups: Cell[][][] = BUCKETS.map(() => []);
  for (const row of result.events.rows) {
    const v = row[at];
    if (typeof v !== 'number') continue;
    groups[BUCKETS.findIndex((b) => v < b.below)].push(row);
  }
  return BUCKETS.map((b, i) => ({
    label: b.label,
    events: groups[i].length,
    forward: fwd.map((f) => (f < 0 ? null : median(groups[i].map((r) => r[f])))),
  })).filter((b) => b.events > 0);
}

export function median(values: Cell[]): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/** One event's measurements: each metric at each observation point. */
export function eventGrid(result: StudyResultData, row: Cell[]): { metric: string; values: (number | null)[] }[] {
  return result.spec.metrics.map((metric) => ({
    metric,
    values: result.offsets.map((o) => {
      const i = result.events.columns.indexOf(metricColumn(metric, o));
      const v = i >= 0 ? row[i] : null;
      return typeof v === 'number' ? v : null;
    }),
  }));
}

/** The difference between two medians, when both exist. */
export function medianGap(a: Stat | null | undefined, b: Stat | null | undefined): number | null {
  return a?.median != null && b?.median != null ? a.median - b.median : null;
}

/** "143 events · 96 stocks · 2018–2026" for the header. */
export function headline(result: StudyResultData): string {
  const s = result.summary;
  const years = [s.first_event, s.last_event].map((d) => d?.slice(0, 4)).filter(Boolean);
  const span = years.length === 2 ? (years[0] === years[1] ? years[0] : `${years[0]}–${years[1]}`) : null;
  return [`${s.events.toLocaleString()} event${s.events === 1 ? '' : 's'}`, `${s.unique_symbols.toLocaleString()} unique stock${s.unique_symbols === 1 ? '' : 's'}`, span]
    .filter(Boolean)
    .join(' · ');
}
