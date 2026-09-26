/** The Study Specification: the product's source of truth for a Study.
 *
 *  A Study is universe → period → event → observation windows → measurements → forward windows →
 *  comparison → output. This document says all of it, and every engine runs from it: today the
 *  Python one (`python/protrade/study.py`, whose `normalize_spec` applies the same rules as
 *  `normalizeSpec` here — keep the two in step). Python is how a Study runs, not what it is.
 *
 *  Field names are snake_case because the document is shared with Python and exported as a file.
 *  Pure. */

import { canonicalFeature, featureLabel, needsBenchmark, windowLabel } from './metrics';

export const SPEC_VERSION = 1;

export type UniverseSource = 'instruments' | 'watchlist' | 'symbols';
export type StudyProvider = 'zerodha' | 'dhan';
export type Exchange = 'NSE' | 'BSE';
export const OPS = ['>', '>=', '<', '<=', 'crosses_above', 'crosses_below'] as const;
export type Op = (typeof OPS)[number];

export interface Condition {
  left: string;
  op: Op;
  /** A number, or another feature's name. */
  right: number | string;
  label?: string;
}

/** A condition judged `at` bars before the event. */
export interface PreEventFilter extends Condition {
  at: number;
}

export interface StudySpec {
  version: number;
  name: string;
  description: string;
  /** The template this Study started from, if any. */
  template: string | null;
  universe: {
    source: UniverseSource;
    provider: StudyProvider;
    exchanges: Exchange[];
    watchlist: string | null;
    symbols: string[];
    /** Rupees. No data source supplies market cap, so a Study with this set can't run (see `readiness.ts`). */
    market_cap_min: number | null;
    /** Rupees a day, the 50-day average of close × volume, judged at the event. */
    min_avg_traded_value: number | null;
    min_price: number | null;
    /** Study only the first N symbols: a quick trial of a large universe. */
    max_symbols: number | null;
  };
  period: { start: string; end: string | null };
  event: { label: string; conditions: Condition[]; cooldown_days: number };
  pre_event_filters: PreEventFilter[];
  /** Bars before the event to observe at, ascending. */
  lookback_windows: number[];
  /** Bars after the event to measure what happened, ascending. */
  forward_windows: number[];
  metrics: string[];
  /** Yes/no traits counted at every observation point ("Above 200 EMA"). */
  characteristics: Condition[];
  /** An index symbol, for relative strength. */
  benchmark: string | null;
  /** When set, the events are split by what came after: those whose price reached `min_return`
   *  above the event's close within `window` bars, against those that didn't (which become the
   *  comparison group instead of random dates). */
  outcome: { window: number; min_return: number } | null;
  control_group: { enabled: boolean; samples_per_event: number; seed: number };
  output: { max_events: number };
}

export const LIMITS = {
  conditions: 8,
  filters: 12,
  windows: 8,
  metrics: 40,
  characteristics: 20,
  symbols: 10_000,
  maxEvents: 10_000,
  window: 1000,
} as const;

export class SpecError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function date(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !DATE.test(value.trim()) || Number.isNaN(Date.parse(`${value.trim()}T00:00:00Z`))) {
    throw new SpecError(`${field} must be a date written YYYY-MM-DD.`);
  }
  return value.trim();
}

function num(value: unknown, field: string, minimum?: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new SpecError(`${field} must be a number.`);
  if (minimum !== undefined && value < minimum) throw new SpecError(`${field} must be at least ${minimum}.`);
  return value;
}

function int(value: unknown, field: string, low: number, high: number, fallback?: number): number {
  if (value === null || value === undefined) {
    if (fallback === undefined) throw new SpecError(`${field} is required.`);
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new SpecError(`${field} must be a whole number.`);
  if (value < low || value > high) throw new SpecError(`${field} must be between ${low} and ${high}.`);
  return value;
}

function windows(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new SpecError(`${field} must list at least one window, in bars.`);
  if (value.length > LIMITS.windows) throw new SpecError(`${field} can hold at most ${LIMITS.windows} windows.`);
  return [...new Set(value.map((v) => int(v, field, 1, LIMITS.window)))].sort((a, b) => a - b);
}

const CONDITION_TEXT = /^\s*([A-Za-z0-9_]+)\s*(>=|<=|>|<|crosses_above|crosses_below)\s*(\S+)\s*$/;

/** A condition from `{left, op, right}` or from text such as `return_252 crosses_above 1.0`. */
export function parseCondition(value: unknown, field = 'condition'): Condition {
  let raw: unknown = value;
  if (typeof value === 'string') {
    const m = CONDITION_TEXT.exec(value);
    if (!m) throw new SpecError(`${field}: write a condition as <feature> <op> <number or feature>.`);
    const n = Number(m[3]);
    raw = { left: m[1], op: m[2], right: Number.isFinite(n) ? n : m[3] };
  }
  if (!isRecord(raw)) throw new SpecError(`${field} must be a condition.`);
  const left = typeof raw.left === 'string' ? canonicalFeature(raw.left) : null;
  if (!left) throw new SpecError(`${field}: unknown feature ${JSON.stringify(raw.left)}.`);
  if (!(OPS as readonly unknown[]).includes(raw.op)) throw new SpecError(`${field}: the operator must be one of ${OPS.join(', ')}.`);
  let right: number | string;
  if (typeof raw.right === 'number' && Number.isFinite(raw.right)) right = raw.right;
  else if (typeof raw.right === 'string' && canonicalFeature(raw.right)) right = canonicalFeature(raw.right)!;
  else throw new SpecError(`${field}: the right side must be a number or a feature.`);
  const out: Condition = { left, op: raw.op as Op, right };
  if (typeof raw.label === 'string' && raw.label.trim()) out.label = raw.label.trim();
  return out;
}

function conditions(value: unknown, field: string, limit: number, needOne: boolean): Condition[] {
  const list = value ?? [];
  if (!Array.isArray(list)) throw new SpecError(`${field} must be a list of conditions.`);
  if (needOne && list.length === 0) throw new SpecError(`${field} needs at least one condition.`);
  if (list.length > limit) throw new SpecError(`${field} can hold at most ${limit} conditions.`);
  return list.map((item, i) => parseCondition(item, `${field}[${i}]`));
}

/** `return_252 crosses_above 1` as a person reads it: "12M return crosses above +100%". */
export function describeCondition(c: Condition): string {
  const op = c.op.replace('_', ' ');
  const right = typeof c.right === 'string' ? featureLabel(c.right) : formatThreshold(c.left, c.right);
  return `${featureLabel(c.left)} ${op} ${right}`;
}

/** The engine's own wording, used as a label when none is given: `return_252 >= 1`. */
export function conditionText(c: Condition): string {
  return `${c.left} ${c.op} ${typeof c.right === 'number' ? String(c.right) : c.right}`;
}

function formatThreshold(feature: string, value: number): string {
  const f = canonicalFeature(feature) ?? feature;
  const percentLike = /^(return|gain_from_low|dist_|slope_|atr_pct|range|volatility|drawdown|max_drawdown|rs|bb_width|macd)/.test(f);
  return percentLike ? `${value > 0 ? '+' : ''}${Math.round(value * 1000) / 10}%` : String(value);
}

/** The spec checked and completed, with every feature name in its canonical spelling. Throws
 *  `SpecError` naming the first problem. The same rules as the engine's `normalize_spec`. */
export function normalizeSpec(input: unknown): StudySpec {
  if (!isRecord(input)) throw new SpecError('A Study Specification is a JSON object.');
  const version = input.version ?? SPEC_VERSION;
  if (version !== SPEC_VERSION) throw new SpecError(`This app runs version ${SPEC_VERSION} specifications, not ${String(version)}.`);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new SpecError('A Study needs a name.');
  if (name.length > 120) throw new SpecError("A Study's name can be at most 120 characters.");

  const u = isRecord(input.universe) ? input.universe : {};
  const source = (u.source ?? 'instruments') as UniverseSource;
  if (!['instruments', 'watchlist', 'symbols'].includes(source)) throw new SpecError('universe.source must be instruments, watchlist or symbols.');
  const provider = (u.provider ?? 'zerodha') as StudyProvider;
  if (provider !== 'zerodha' && provider !== 'dhan') throw new SpecError('universe.provider must be zerodha or dhan.');
  const exchanges = u.exchanges ?? ['NSE'];
  if (!Array.isArray(exchanges) || exchanges.length === 0 || exchanges.some((e) => e !== 'NSE' && e !== 'BSE')) {
    throw new SpecError('universe.exchanges must list one or more of NSE, BSE.');
  }
  const watchlist = typeof u.watchlist === 'string' && u.watchlist.trim() ? u.watchlist.trim() : null;
  if (source === 'watchlist' && !watchlist) throw new SpecError('universe.watchlist must name a watchlist.');
  const symbols = u.symbols ?? [];
  if (!Array.isArray(symbols) || symbols.some((s) => typeof s !== 'string' || !s.includes(':'))) {
    throw new SpecError('universe.symbols must be a list of symbols like zerodha:NSE:RELIANCE.');
  }
  if (source === 'symbols' && symbols.length === 0) throw new SpecError('universe.symbols needs at least one symbol.');
  if (symbols.length > LIMITS.symbols) throw new SpecError(`universe.symbols can hold at most ${LIMITS.symbols} symbols.`);

  const period = isRecord(input.period) ? input.period : {};
  const start = date(period.start, 'period.start');
  const end = date(period.end, 'period.end');
  if (!start) throw new SpecError('period.start is required: the first date an event may fall on.');
  if (end && end <= start) throw new SpecError('period.end must come after period.start.');

  const event = isRecord(input.event) ? input.event : {};
  const eventConditions = conditions(event.conditions, 'event.conditions', LIMITS.conditions, true);
  const label =
    typeof event.label === 'string' && event.label.trim() ? event.label.trim() : eventConditions.map(conditionText).join(' and ');

  const filtersRaw = input.pre_event_filters ?? [];
  if (!Array.isArray(filtersRaw)) throw new SpecError('pre_event_filters must be a list of conditions.');
  if (filtersRaw.length > LIMITS.filters) throw new SpecError(`pre_event_filters can hold at most ${LIMITS.filters} conditions.`);
  const preEventFilters: PreEventFilter[] = filtersRaw.map((item, i) => ({
    ...parseCondition(item, `pre_event_filters[${i}]`),
    at: int(isRecord(item) ? item.at : undefined, `pre_event_filters[${i}].at`, 0, LIMITS.window, 0),
  }));

  const metricsRaw = input.metrics;
  if (!Array.isArray(metricsRaw) || metricsRaw.length === 0) throw new SpecError('metrics must list at least one feature to measure.');
  if (metricsRaw.length > LIMITS.metrics) throw new SpecError(`metrics can hold at most ${LIMITS.metrics} features.`);
  const metrics = [
    ...new Set(
      metricsRaw.map((m) => {
        const key = typeof m === 'string' ? canonicalFeature(m) : null;
        if (!key) throw new SpecError(`metrics: unknown feature ${JSON.stringify(m)}.`);
        return key;
      }),
    ),
  ];

  const characteristics = conditions(input.characteristics, 'characteristics', LIMITS.characteristics, false).map((c) => ({
    ...c,
    label: c.label ?? conditionText(c),
  }));

  const benchmarkRaw = input.benchmark;
  if (benchmarkRaw !== null && benchmarkRaw !== undefined && (typeof benchmarkRaw !== 'string' || !benchmarkRaw.includes(':'))) {
    throw new SpecError('benchmark must be a symbol like zerodha:NSE:NIFTY_500, or null.');
  }
  const control = isRecord(input.control_group) ? input.control_group : {};
  const output = isRecord(input.output) ? input.output : {};
  let outcome: StudySpec['outcome'] = null;
  if (input.outcome !== null && input.outcome !== undefined) {
    if (!isRecord(input.outcome)) throw new SpecError('outcome must be an object with window and min_return, or null.');
    const minReturn = num(input.outcome.min_return, 'outcome.min_return', -1);
    if (minReturn === null) throw new SpecError('outcome.min_return is required.');
    outcome = { window: int(input.outcome.window, 'outcome.window', 1, LIMITS.window), min_return: minReturn };
  }

  const spec: StudySpec = {
    version: SPEC_VERSION,
    name,
    description: typeof input.description === 'string' ? input.description : '',
    template: typeof input.template === 'string' ? input.template : null,
    universe: {
      source,
      provider,
      exchanges: [...new Set(exchanges as Exchange[])],
      watchlist,
      symbols: [...new Set((symbols as string[]).map((s) => s.trim()))],
      market_cap_min: num(u.market_cap_min, 'universe.market_cap_min', 0),
      min_avg_traded_value: num(u.min_avg_traded_value, 'universe.min_avg_traded_value', 0),
      min_price: num(u.min_price, 'universe.min_price', 0),
      max_symbols: u.max_symbols === null || u.max_symbols === undefined ? null : int(u.max_symbols, 'universe.max_symbols', 1, LIMITS.symbols),
    },
    period: { start, end },
    event: { label, conditions: eventConditions, cooldown_days: int(event.cooldown_days, 'event.cooldown_days', 1, 2520, 252) },
    pre_event_filters: preEventFilters,
    lookback_windows: windows(input.lookback_windows ?? [252, 126, 63, 21], 'lookback_windows'),
    forward_windows: windows(input.forward_windows ?? [63, 126, 252], 'forward_windows'),
    metrics,
    characteristics,
    benchmark: typeof benchmarkRaw === 'string' ? benchmarkRaw.trim() : null,
    outcome,
    control_group: {
      enabled: control.enabled === undefined ? true : Boolean(control.enabled),
      samples_per_event: int(control.samples_per_event, 'control_group.samples_per_event', 1, 10, 2),
      seed: int(control.seed, 'control_group.seed', 0, 2 ** 31 - 1, 42),
    },
    output: { max_events: int(output.max_events, 'output.max_events', 1, LIMITS.maxEvents, 5000) },
  };
  if (!spec.benchmark) {
    const needing = requiredFeatures(spec).filter(needsBenchmark);
    if (needing.length) throw new SpecError(`${needing.join(', ')} compare against an index: set a benchmark (e.g. zerodha:NSE:NIFTY_500).`);
  }
  return spec;
}

/** The problem with a spec, or null when it is runnable as far as its shape goes. */
export function specProblem(input: unknown): string | null {
  try {
    normalizeSpec(input);
    return null;
  } catch (err) {
    return err instanceof SpecError ? err.message : String(err);
  }
}

/** Every feature a run computes. */
export function requiredFeatures(spec: StudySpec): string[] {
  const names = ['close', 'high', 'low', 'avg_traded_value_50', ...spec.metrics];
  for (const c of [...spec.event.conditions, ...spec.pre_event_filters, ...spec.characteristics]) {
    names.push(c.left);
    if (typeof c.right === 'string') names.push(c.right);
  }
  return [...new Set(names)];
}

/** The observation points: before the event (negative), the event, after it. */
export function studyOffsets(spec: StudySpec): number[] {
  return [...[...spec.lookback_windows].reverse().map((w) => -w), 0, ...spec.forward_windows];
}

/** The event table's column for a metric at an observation point: `rsi_14@-63`, `rsi_14@0`, `rsi_14@+63`. */
export function metricColumn(metric: string, offset: number): string {
  return `${metric}@${offset === 0 ? '0' : offset > 0 ? `+${offset}` : String(offset)}`;
}

/** A plain-language reading of the spec, as the builder shows it before anything runs. */
export interface Interpretation {
  heading: string;
  lines: string[];
}

export function interpret(spec: StudySpec): Interpretation[] {
  const u = spec.universe;
  const universe =
    u.source === 'instruments'
      ? [`${u.exchanges.join(' + ')} listed equities (${u.provider === 'zerodha' ? 'Zerodha' : 'Dhan'} instrument list)`]
      : u.source === 'watchlist'
        ? [`The watchlist "${u.watchlist}"`]
        : [`${u.symbols.length} chosen symbol${u.symbols.length === 1 ? '' : 's'}`];
  if (u.market_cap_min !== null) universe.push(`Market cap > ₹${(u.market_cap_min / 1e7).toLocaleString('en-IN')} Cr`);
  if (u.min_avg_traded_value !== null) universe.push(`Average traded value (50D) ≥ ₹${(u.min_avg_traded_value / 1e7).toLocaleString('en-IN')} Cr a day, at the event`);
  if (u.min_price !== null) universe.push(`Price ≥ ₹${u.min_price}`);
  if (u.max_symbols !== null) universe.push(`First ${u.max_symbols} symbols only (a trial run)`);
  const out: Interpretation[] = [
    { heading: 'Universe', lines: universe },
    { heading: 'Study period', lines: [`Events from ${spec.period.start} to ${spec.period.end ?? 'the latest data'}`] },
    {
      heading: 'Event',
      lines: [
        ...spec.event.conditions.map(describeCondition),
        `First day it holds; then no new event for the same stock for ${spec.event.cooldown_days} bars`,
      ],
    },
  ];
  if (spec.pre_event_filters.length) {
    out.push({
      heading: 'Pre-event conditions',
      lines: spec.pre_event_filters.map((f) => `${describeCondition(f)} ${f.at === 0 ? 'at the event' : `${windowLabel(f.at)} before`}`),
    });
  }
  out.push(
    { heading: 'Observation windows', lines: spec.lookback_windows.map((w) => `${windowLabel(w)} before the event`).reverse() },
    { heading: 'Forward windows', lines: spec.forward_windows.map((w) => `${windowLabel(w)} after`) },
    { heading: 'Metrics', lines: spec.metrics.map(featureLabel) },
  );
  if (spec.characteristics.length) out.push({ heading: 'Characteristics counted', lines: spec.characteristics.map((c) => c.label ?? describeCondition(c)) });
  out.push({
    heading: 'Comparison',
    lines: [
      spec.outcome
        ? `Events that rose ${Math.round(spec.outcome.min_return * 100)}% or more within ${windowLabel(spec.outcome.window)}, against the events that didn't`
        : spec.control_group.enabled
        ? `Control group: ${spec.control_group.samples_per_event} random non-event dates per event, same universe and filters (seed ${spec.control_group.seed})`
        : 'No control group',
      spec.benchmark ? `Benchmark for relative strength: ${spec.benchmark}` : 'No benchmark index',
    ],
  });
  return out;
}
