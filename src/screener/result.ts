/** A screen's result, as the engine posts it (`protrade/screen.py` `Screen.run`). It is script
 *  output, so it is untrusted: `parseScreenResult` checks every part (the spec through
 *  `normalizeScreen`) and refuses what it doesn't recognise rather than guessing. Nothing here is
 *  ever drawn as HTML. Pure. */

import { toCsv } from '../studies/exports';
import { canonicalFeature, featureLabel } from '../studies/metrics';
import { displayTicker } from '../lib/symbols';
import { normalizeScreen, outputColumns, ScreenError, type ScreenSpec } from './spec';

export const RESULT_FORMAT = 1;
const MAX_ROWS = 5_000;
const MAX_WARNINGS = 20;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ScreenRow {
  symbol: string;
  name: string | null;
  /** The latest bar's date, which the filters were judged on. */
  date: string;
  /** One per column, in `columns` order; null where a feature had no value. */
  values: (number | null)[];
}

export interface ScreenResult {
  spec: ScreenSpec;
  columns: string[];
  rows: ScreenRow[];
  meta: {
    engineVersion: string;
    executedAt: string;
    seconds: number;
    /** The newest bar across the universe: the day the screen describes. */
    asOf: string;
    requested: number;
    loaded: number;
    failed: number;
    stale: number;
    /** Matches before the cap; `rows` may hold fewer. */
    matched: number;
    /** Ruled out on today's quote alone, without reading their history (counted in `loaded`). */
    prefiltered: number;
  };
  warnings: { code: string; message: string }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const text = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null);

function row(value: unknown, width: number): ScreenRow | null {
  if (!isRecord(value)) return null;
  const symbol = text(value.symbol, 100);
  const date = text(value.date, 10);
  if (!symbol || !symbol.includes(':') || !date || !DATE.test(date)) return null;
  const name = value.name === null || value.name === undefined ? null : text(value.name, 200);
  if (name === null && value.name !== null && value.name !== undefined) return null;
  if (!Array.isArray(value.values) || value.values.length !== width) return null;
  const values: (number | null)[] = [];
  for (const v of value.values) {
    if (v === null) values.push(null);
    else if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
    else return null;
  }
  return { symbol, name, date, values };
}

/** The result checked, or null when it isn't one this version of the app can read. */
export function parseScreenResult(data: unknown): ScreenResult | null {
  if (!isRecord(data) || data.format !== RESULT_FORMAT) return null;
  let spec: ScreenSpec;
  try {
    spec = normalizeScreen(data.spec);
  } catch (err) {
    if (err instanceof ScreenError) return null;
    throw err;
  }
  // The columns are the spec's own; anything else would label numbers wrongly.
  const columns = outputColumns(spec);
  if (!Array.isArray(data.columns) || data.columns.length !== columns.length || data.columns.some((c, i) => canonicalFeature(String(c)) !== columns[i])) return null;
  if (!Array.isArray(data.rows) || data.rows.length > MAX_ROWS) return null;
  const rows: ScreenRow[] = [];
  for (const item of data.rows) {
    const parsed = row(item, columns.length);
    if (!parsed) return null;
    rows.push(parsed);
  }
  const m = isRecord(data.meta) ? data.meta : {};
  const asOf = text(m.as_of, 10);
  const executedAt = text(m.executed_at, 40);
  const numbers = [m.symbols_requested, m.symbols_loaded, m.symbols_failed, m.symbols_stale, m.matched].map(count);
  if (!asOf || !DATE.test(asOf) || !executedAt || numbers.some((n) => n === null)) return null;
  const [requested, loaded, failed, stale, matched] = numbers as number[];
  if (matched < rows.length) return null;
  // Results saved before the quote pre-filter existed have no count: none were ruled out that way.
  const prefiltered = m.prefiltered === undefined ? 0 : count(m.prefiltered);
  if (prefiltered === null) return null;
  const warnings = (Array.isArray(data.warnings) ? data.warnings : [])
    .filter(isRecord)
    .map((w) => ({ code: text(w.code, 40) ?? '', message: text(w.message, 500) ?? '' }))
    .filter((w) => w.code && w.message)
    .slice(0, MAX_WARNINGS);
  return {
    spec,
    columns,
    rows,
    meta: {
      engineVersion: text(m.engine_version, 20) ?? '?',
      executedAt,
      seconds: typeof m.seconds === 'number' && Number.isFinite(m.seconds) ? m.seconds : 0,
      asOf,
      requested,
      loaded,
      failed,
      stale,
      matched,
      prefiltered,
    },
    warnings,
  };
}

/** Which column a table is sorted by: `symbol`, `name`, or a feature column's index. */
export type SortKey = 'symbol' | 'name' | number;

/** The rows sorted by one column, blanks last whichever way; in the engine's order when `sort` is null. */
export function sortScreenRows(rows: readonly ScreenRow[], sort: { key: SortKey; descending: boolean } | null): ScreenRow[] {
  if (!sort) return [...rows];
  const dir = sort.descending ? -1 : 1;
  const pick = (r: ScreenRow): string | number | null =>
    sort.key === 'symbol' ? displayTicker(r.symbol) : sort.key === 'name' ? r.name : (r.values[sort.key] ?? null);
  return [...rows].sort((a, b) => {
    const x = pick(a);
    const y = pick(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
  });
}

/** The table as CSV: raw numbers (fractions stay fractions), headed by the feature's label. */
export function screenCsv(result: ScreenResult, rows: readonly ScreenRow[] = result.rows): string {
  return toCsv(
    ['Symbol', 'Name', 'Date', ...result.columns.map(featureLabel)],
    rows.map((r) => [r.symbol, r.name, r.date, ...r.values]),
  );
}
