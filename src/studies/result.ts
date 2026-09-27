/** A Study's result, as the engine posts it (`kind: "study"`) and as it is stored.
 *
 *  It comes from a Python process, which runs code the user can edit, so it is untrusted: every
 *  part is checked and squared off here, anything malformed is refused, and nothing in it is ever
 *  drawn as HTML. The spec inside is re-validated with the same rules the builder uses. Pure. */

import type { Cell } from '../python/results';
import { MEASURE_STATS, normalizeSpec, type MeasureStat, type StudySpec } from './spec';

export const RESULT_FORMAT = 1;

export interface Stat {
  count: number;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  p25: number | null;
  p75: number | null;
}

export interface Share {
  count: number;
  true: number;
  share: number | null;
}

export interface ForwardStat extends Stat {
  positive: Share;
  max_gain_median: number | null;
  max_drawdown_median: number | null;
}

export interface PathBand {
  offsets: number[];
  median: (number | null)[];
  p25: (number | null)[];
  p75: (number | null)[];
  count: number[];
}

export interface StudyMeta {
  executed_at: string;
  engine_version: string | null;
  /** A fingerprint of the engine's code that produced this result. */
  engine_build: string | null;
  app_version: string | null;
  python_version: string | null;
  pandas_version: string | null;
  data_source: string | null;
  data_from: string | null;
  data_through: string | null;
  data_version: string | null;
  symbols_requested: number;
  symbols_loaded: number;
  symbols_failed: number;
  symbols_short_history: number;
  /** Symbols whose bars were kept: the rest never passed the filters in the period. */
  symbols_kept: number | null;
  /** Instrument-list rows left out as not stocks, or as a company's second listing. */
  listings_skipped: number;
  history_bars_needed: number | null;
  elapsed_seconds: number | null;
  /** Seconds per stage of the run. */
  timings: Record<string, number>;
}

/** A test of events against the comparison group. `p` is the test's own p-value and `q` the same
 *  adjusted for the Study's many comparisons (Benjamini–Hochberg), which is the one to read. */
export interface TestResult {
  p: number | null;
  q: number | null;
  n_events: number;
  n_control: number;
  /** Measurements: Cliff's delta, −1…1 (positive: events higher). */
  effect: number | null;
  /** Characteristics: the difference in shares (events − comparison) and its 95% interval. */
  diff: number | null;
  low: number | null;
  high: number | null;
}

/** A difference that stands out: q < 0.05 (and, for a measurement, at least a small effect). */
export type Finding =
  | { kind: 'metric'; metric: string; offset: number; test: TestResult }
  | { kind: 'characteristic'; label: string; offset: number; test: TestResult }
  | { kind: 'forward'; window: number; test: TestResult }
  | { kind: 'measure'; index: number; label: string; test: TestResult };

/** Why an event has, or hasn't, a value for a measure (see `python/protrade/measures.py`). */
export const MEASURE_STATUSES = ['ok', 'capped', 'never', 'too_recent', 'no_history', 'not_found', 'empty'] as const;
export type MeasureStatus = (typeof MEASURE_STATUSES)[number];
/** Statuses that carry a value: `capped` is a lower bound, `never` ranks after every number. */
export const MEASURED_STATUSES: readonly MeasureStatus[] = ['ok', 'capped', 'never'];

/** A measure's values across a group. Percentiles that fall among `never` values are null. */
export interface MeasureSummary extends Stat {
  status: Record<MeasureStatus, number>;
}

export interface MeasureResult {
  index: number;
  label: string;
  stat: MeasureStat;
  events: MeasureSummary;
  control: MeasureSummary | null;
  /** For a window with a found endpoint: how long the windows were. */
  window_bars: Stat | null;
  test: TestResult | null;
  histogram: { edges: number[]; events: number[]; control: number[] } | null;
  /** For a condition measure: the share of events (and control dates) where the conditions held,
   *  day by day across the window. */
  timeline: { offsets: number[]; events: (number | null)[]; control: (number | null)[] | null; count: number[] } | null;
}

export interface StudySummary {
  events: number;
  unique_symbols: number;
  first_event: string | null;
  last_event: string | null;
  median_price: number | null;
  median_avg_traded_value: number | null;
  median_event_value: number | null;
  control_samples: number;
  control_kind: 'random' | 'outcome' | 'none';
  outcome: { met: number; not_met: number; unknown: number } | null;
  findings: Finding[];
}

export interface StudyResultData {
  format: number;
  spec: StudySpec;
  meta: StudyMeta;
  availability: Record<string, boolean>;
  warnings: { code: string; message: string }[];
  summary: StudySummary;
  offsets: number[];
  events: { columns: string[]; rows: Cell[][]; total: number };
  stats: { metric: string; offset: number; events: Stat; control: Stat | null; test: TestResult | null }[];
  characteristics: { index: number; label: string; offset: number; events: Share; control: Share | null; test: TestResult | null }[];
  forward: { window: number; events: ForwardStat; control: ForwardStat | null; test: TestResult | null }[];
  /** One per `spec.measures` entry. Empty for runs made before measures existed. */
  measures: MeasureResult[];
  histograms: { metric: string; offset: number; edges: number[]; events: number[]; control: number[] }[];
  path: PathBand | null;
  control_path: PathBand | null;
  failed: { symbol: string; error: string }[];
}

const MAX_ROWS = 10_000;
const MAX_COLUMNS = 1_000;
const MAX_LIST = 5_000;
const MAX_TEXT = 1_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, MAX_LIST) : []);

function cell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, MAX_TEXT);
  return n(value);
}

function stat(v: unknown): Stat {
  const r = isRecord(v) ? v : {};
  return { count: count(r.count), mean: n(r.mean), median: n(r.median), min: n(r.min), max: n(r.max), p25: n(r.p25), p75: n(r.p75) };
}

function share(v: unknown): Share {
  const r = isRecord(v) ? v : {};
  const s = n(r.share);
  return { count: count(r.count), true: count(r.true), share: s === null ? null : Math.min(Math.max(s, 0), 1) };
}

function forwardStat(v: unknown): ForwardStat {
  const r = isRecord(v) ? v : {};
  return { ...stat(r), positive: share(r.positive), max_gain_median: n(r.max_gain_median), max_drawdown_median: n(r.max_drawdown_median) };
}

function unit(v: unknown): number | null {
  const x = n(v);
  return x === null ? null : Math.min(Math.max(x, 0), 1);
}

function testResult(v: unknown): TestResult | null {
  if (!isRecord(v)) return null;
  const effect = n(v.effect);
  const diff = n(v.diff);
  const low = n(v.low);
  const high = n(v.high);
  return {
    p: unit(v.p),
    q: unit(v.q),
    n_events: count(v.n_events),
    n_control: count(v.n_control),
    effect: effect === null ? null : Math.min(Math.max(effect, -1), 1),
    diff: diff === null ? null : Math.min(Math.max(diff, -1), 1),
    low,
    high,
  };
}

function finding(v: unknown): Finding | null {
  if (!isRecord(v)) return null;
  const test = testResult(v.test);
  if (!test) return null;
  const offset = int(v.offset);
  if (v.kind === 'metric') {
    const metric = text(v.metric);
    return metric && offset !== null ? { kind: 'metric', metric, offset, test } : null;
  }
  if (v.kind === 'characteristic') {
    const label = text(v.label);
    return label && offset !== null ? { kind: 'characteristic', label, offset, test } : null;
  }
  if (v.kind === 'forward') {
    const window = int(v.window);
    return window !== null ? { kind: 'forward', window, test } : null;
  }
  if (v.kind === 'measure') {
    const index = int(v.index);
    const label = text(v.label);
    return index !== null && index >= 0 && label ? { kind: 'measure', index, label, test } : null;
  }
  return null;
}

function measureSummary(v: unknown): MeasureSummary {
  const r = isRecord(v) ? v : {};
  const s = isRecord(r.status) ? r.status : {};
  return { ...stat(r), status: Object.fromEntries(MEASURE_STATUSES.map((k) => [k, count(s[k])])) as Record<MeasureStatus, number> };
}

function shares(v: unknown, length: number): (number | null)[] | null {
  if (!Array.isArray(v) || v.length !== length) return null;
  return v.map(unit);
}

function measureResult(v: unknown, spec: StudySpec): MeasureResult | null {
  if (!isRecord(v)) return null;
  const index = int(v.index);
  const label = text(v.label);
  const stat_ = v.stat as MeasureStat;
  if (index === null || index < 0 || index >= spec.measures.length || !label || !(MEASURE_STATS as readonly unknown[]).includes(stat_)) return null;
  let histogram: MeasureResult['histogram'] = null;
  if (isRecord(v.histogram)) {
    const edges = numbers(v.histogram.edges);
    const ev = numbers(v.histogram.events);
    const cv = numbers(v.histogram.control);
    if (edges && edges.length >= 2 && ev && cv && ev.length === edges.length - 1 && cv.length === edges.length - 1) {
      histogram = { edges, events: ev.map((x) => Math.max(0, x)), control: cv.map((x) => Math.max(0, x)) };
    }
  }
  let timeline: MeasureResult['timeline'] = null;
  if (isRecord(v.timeline) && Array.isArray(v.timeline.offsets)) {
    const offsets = v.timeline.offsets.slice(0, 200).map(int);
    const events = shares(v.timeline.events, offsets.length);
    const counts = Array.isArray(v.timeline.count) && v.timeline.count.length === offsets.length ? v.timeline.count.map(count) : null;
    const control = v.timeline.control == null ? null : shares(v.timeline.control, offsets.length);
    const controlOk = v.timeline.control == null || control !== null;
    if (offsets.length >= 2 && offsets.every((o) => o !== null) && events && counts && controlOk) {
      timeline = { offsets: offsets as number[], events, control, count: counts };
    }
  }
  return {
    index,
    label,
    stat: stat_,
    events: measureSummary(v.events),
    control: v.control == null ? null : measureSummary(v.control),
    window_bars: v.window_bars == null ? null : stat(v.window_bars),
    test: testResult(v.test),
    histogram,
    timeline,
  };
}

function band(v: unknown): PathBand | null {
  if (!isRecord(v) || !Array.isArray(v.offsets)) return null;
  const offsets = list(v.offsets).map(int);
  if (offsets.length < 2 || offsets.some((o) => o === null)) return null;
  const column = (x: unknown) => offsets.map((_, i) => (Array.isArray(x) ? n(x[i]) : null));
  return {
    offsets: offsets as number[],
    median: column(v.median),
    p25: column(v.p25),
    p75: column(v.p75),
    count: offsets.map((_, i) => (Array.isArray(v.count) ? count(v.count[i]) : 0)),
  };
}

function numbers(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.slice(0, 200).map(n);
  return out.some((x) => x === null) ? null : (out as number[]);
}

/** The result, checked; or null when it isn't one this version can show. */
export function parseStudyResult(data: unknown): StudyResultData | null {
  if (!isRecord(data) || data.format !== RESULT_FORMAT) return null;
  let spec: StudySpec;
  try {
    spec = normalizeSpec(data.spec);
  } catch {
    return null;
  }
  const events = isRecord(data.events) ? data.events : null;
  if (!events || !Array.isArray(events.columns) || !Array.isArray(events.rows)) return null;
  if (events.columns.length === 0 || events.columns.length > MAX_COLUMNS || !events.columns.every((c) => typeof c === 'string')) return null;
  const columns = (events.columns as string[]).map((c) => c.slice(0, 200));
  const rows: Cell[][] = [];
  for (const row of events.rows.slice(0, MAX_ROWS)) {
    if (!Array.isArray(row)) return null;
    rows.push(columns.map((_, i) => cell(row[i])));
  }
  const offsets = list(data.offsets).map(int).filter((o): o is number => o !== null);

  const meta = isRecord(data.meta) ? data.meta : {};
  const summary = isRecord(data.summary) ? data.summary : {};
  const outcome = isRecord(summary.outcome) ? summary.outcome : null;
  const kind = summary.control_kind;

  return {
    format: RESULT_FORMAT,
    spec,
    meta: {
      executed_at: text(meta.executed_at) ?? '',
      engine_version: text(meta.engine_version),
      engine_build: text(meta.engine_build),
      app_version: text(meta.app_version),
      python_version: text(meta.python_version),
      pandas_version: text(meta.pandas_version),
      data_source: text(meta.data_source),
      data_from: text(meta.data_from),
      data_through: text(meta.data_through),
      data_version: text(meta.data_version),
      symbols_requested: count(meta.symbols_requested),
      symbols_loaded: count(meta.symbols_loaded),
      symbols_failed: count(meta.symbols_failed),
      symbols_short_history: count(meta.symbols_short_history),
      symbols_kept: n(meta.symbols_kept),
      listings_skipped: count(meta.listings_skipped),
      history_bars_needed: n(meta.history_bars_needed),
      elapsed_seconds: n(meta.elapsed_seconds),
      timings: Object.fromEntries(
        Object.entries(isRecord(meta.timings) ? meta.timings : {})
          .filter((entry): entry is [string, number] => n(entry[1]) !== null)
          .slice(0, 20)
          .map(([k, v]) => [k.slice(0, 40), v]),
      ),
    },
    availability: Object.fromEntries(
      Object.entries(isRecord(data.availability) ? data.availability : {})
        .filter(([, v]) => typeof v === 'boolean')
        .slice(0, 20) as [string, boolean][],
    ),
    warnings: list(data.warnings)
      .filter(isRecord)
      .map((w) => ({ code: text(w.code) ?? '', message: text(w.message) ?? '' }))
      .filter((w) => w.message),
    summary: {
      events: count(summary.events),
      unique_symbols: count(summary.unique_symbols),
      first_event: text(summary.first_event),
      last_event: text(summary.last_event),
      median_price: n(summary.median_price),
      median_avg_traded_value: n(summary.median_avg_traded_value),
      median_event_value: n(summary.median_event_value),
      control_samples: count(summary.control_samples),
      control_kind: kind === 'random' || kind === 'outcome' ? kind : 'none',
      outcome: outcome ? { met: count(outcome.met), not_met: count(outcome.not_met), unknown: count(outcome.unknown) } : null,
      findings: list(summary.findings)
        .slice(0, 20)
        .map(finding)
        .filter((f): f is Finding => f !== null),
    },
    offsets,
    events: { columns, rows, total: Math.max(count(events.total), rows.length) },
    stats: list(data.stats)
      .filter(isRecord)
      .flatMap((s) => {
        const offset = int(s.offset);
        const metric = text(s.metric);
        return metric && offset !== null ? [{ metric, offset, events: stat(s.events), control: s.control == null ? null : stat(s.control), test: testResult(s.test) }] : [];
      }),
    characteristics: list(data.characteristics)
      .filter(isRecord)
      .flatMap((c) => {
        const offset = int(c.offset);
        const label = text(c.label);
        return label && offset !== null
          ? [{ index: count(c.index), label, offset, events: share(c.events), control: c.control == null ? null : share(c.control), test: testResult(c.test) }]
          : [];
      }),
    forward: list(data.forward)
      .filter(isRecord)
      .flatMap((f) => {
        const window = int(f.window);
        return window !== null ? [{ window, events: forwardStat(f.events), control: f.control == null ? null : forwardStat(f.control), test: testResult(f.test) }] : [];
      }),
    measures: list(data.measures)
      .map((m) => measureResult(m, spec))
      .filter((m): m is MeasureResult => m !== null),
    histograms: list(data.histograms)
      .filter(isRecord)
      .flatMap((h) => {
        const offset = int(h.offset);
        const metric = text(h.metric);
        const edges = numbers(h.edges);
        const ev = numbers(h.events);
        const cv = numbers(h.control);
        if (!metric || offset === null || !edges || edges.length < 2 || !ev || !cv) return [];
        const bins = edges.length - 1;
        if (ev.length !== bins || cv.length !== bins) return [];
        return [{ metric, offset, edges, events: ev.map((x) => Math.max(0, x)), control: cv.map((x) => Math.max(0, x)) }];
      }),
    path: band(data.path),
    control_path: band(data.control_path),
    failed: list(data.failed)
      .filter(isRecord)
      .map((f) => ({ symbol: text(f.symbol) ?? '', error: text(f.error) ?? '' }))
      .filter((f) => f.symbol)
      .slice(0, 200),
  };
}

/** The few figures a list of runs shows, stored beside the full result. */
export interface RunSummary {
  events: number;
  uniqueSymbols: number;
  firstEvent: string | null;
  lastEvent: string | null;
  dataThrough: string | null;
}

export function runSummary(result: StudyResultData): RunSummary {
  return {
    events: result.summary.events,
    uniqueSymbols: result.summary.unique_symbols,
    firstEvent: result.summary.first_event,
    lastEvent: result.summary.last_event,
    dataThrough: result.meta.data_through,
  };
}

export function parseRunSummary(json: string): RunSummary | null {
  try {
    const v: unknown = JSON.parse(json);
    if (!isRecord(v)) return null;
    return {
      events: count(v.events),
      uniqueSymbols: count(v.uniqueSymbols),
      firstEvent: text(v.firstEvent),
      lastEvent: text(v.lastEvent),
      dataThrough: text(v.dataThrough),
    };
  } catch {
    return null;
  }
}

/** One event row as a record, by column name. */
export function eventRecord(result: StudyResultData, row: Cell[]): Record<string, Cell> {
  return Object.fromEntries(result.events.columns.map((c, i) => [c, row[i] ?? null]));
}

export function statFor(result: StudyResultData, metric: string, offset: number) {
  return result.stats.find((s) => s.metric === metric && s.offset === offset) ?? null;
}

/** How many events a measure has a value for (`ok`, `capped` and `never`). */
export function measuredCount(s: MeasureSummary): number {
  return MEASURED_STATUSES.reduce((sum, k) => sum + s.status[k], 0);
}
