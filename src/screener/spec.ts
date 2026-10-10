/** A screen: which stocks meet a set of conditions on their latest bar, and which columns to show.
 *
 *  The Python engine runs it (`python/protrade/screen.py`, whose `normalize_screen` applies the same
 *  rules as `normalizeScreen` here — keep the two in step; both run `fixtures/screen-cases.json`).
 *  It is written in the Studies' feature grammar (`studies/metrics.ts`), so the numbers match a
 *  Study's. Field names are snake_case because the document is shared with Python. Pure. */

import { BARS_PER_INTERVAL, canonicalFeature, featureInterval, needsBenchmark } from '../studies/metrics';
import { parseCondition, SERIES, SpecError, type Condition, type Exchange, type Series, type StudyProvider, type UniverseSource } from '../studies/spec';

export const SCREEN_VERSION = 1;

export const SCREEN_LIMITS = {
  filters: 20,
  columns: 30,
  symbols: 10_000,
  name: 120,
} as const;

export interface ScreenSpec {
  version: number;
  name: string;
  universe: {
    source: UniverseSource;
    provider: StudyProvider;
    exchanges: Exchange[];
    series: Series[];
    watchlist: string | null;
    symbols: string[];
    /** Screen only the first N symbols: a quick trial of a large universe. */
    max_symbols: number | null;
  };
  /** All must hold (AND) on a symbol's latest bar. `crosses_*` means it crossed on that bar. */
  filters: Condition[];
  columns: string[];
  /** The order matches come back in; also which ones are kept when there are too many to send. */
  sort: { column: string; descending: boolean } | null;
  /** An index symbol, for relative strength. */
  benchmark: string | null;
}

export class ScreenError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The columns a result has: those asked for, then every feature a filter reads that isn't one
 *  already, so each match shows why it matched. The engine's `output_columns`. */
/** Features today's quote alone decides: the day's own bar and the previous close. The same list as
 *  `SNAPSHOT_FEATURES` in `protrade/screen.py`; keep the two in step. */
export const SNAPSHOT_FEATURES: readonly string[] = ['open', 'high', 'low', 'close', 'volume', 'gap', 'gap_up', 'gap_down', 'return_1', 'change_1'];

const conditionFeatures = (c: Condition): string[] => [c.left, ...(typeof c.right === 'string' ? [c.right] : [])];

const quoteFeature = (name: string) => {
  const key = canonicalFeature(name);
  return key !== null && featureInterval(key) === 'D' && SNAPSHOT_FEATURES.includes(key);
};

/** Whether the engine judges a filter on today's quote before reading history (`snapshot_decidable`
 *  in `protrade/screen.py`): every feature it reads is a quote one, and a crossing compares the close. */
export function snapshotDecidable(c: Condition): boolean {
  const names = conditionFeatures(c);
  if (!names.every(quoteFeature)) return false;
  return (c.op !== 'crosses_above' && c.op !== 'crosses_below') || names.every((n) => canonicalFeature(n) === 'close');
}

/** How a run uses today's quote: `all` when it decides every filter and column (a stock quoted today
 *  needs no history at all), `some` when it can rule stocks out first, `none` otherwise. */
export function quoteUse(spec: Pick<ScreenSpec, 'columns' | 'filters'>): 'all' | 'some' | 'none' {
  if (!spec.filters.some(snapshotDecidable)) return 'none';
  return spec.filters.every(snapshotDecidable) && outputColumns(spec).every(quoteFeature) ? 'all' : 'some';
}

export function outputColumns(spec: Pick<ScreenSpec, 'columns' | 'filters'>): string[] {
  const names = [...spec.columns];
  for (const c of spec.filters) {
    for (const name of [c.left, ...(typeof c.right === 'string' ? [c.right] : [])]) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** The screen checked and completed, every feature in its canonical spelling. Throws `ScreenError`
 *  naming the first problem. The same rules as the engine's `normalize_screen`. */
export function normalizeScreen(input: unknown): ScreenSpec {
  if (!isRecord(input)) throw new ScreenError('A screen is a JSON object.');
  const version = input.version ?? SCREEN_VERSION;
  if (version !== SCREEN_VERSION) throw new ScreenError(`This app runs version ${SCREEN_VERSION} screens, not ${String(version)}.`);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new ScreenError('A screen needs a name.');
  if (name.length > SCREEN_LIMITS.name) throw new ScreenError(`A screen's name can be at most ${SCREEN_LIMITS.name} characters.`);

  const u = isRecord(input.universe) ? input.universe : {};
  const source = (u.source ?? 'instruments') as UniverseSource;
  if (!['instruments', 'watchlist', 'symbols'].includes(source)) throw new ScreenError('universe.source must be instruments, watchlist or symbols.');
  const provider = (u.provider ?? 'zerodha') as StudyProvider;
  if (provider !== 'zerodha') throw new ScreenError('universe.provider must be zerodha.');
  const exchanges = u.exchanges ?? ['NSE'];
  if (!Array.isArray(exchanges) || exchanges.length === 0 || exchanges.some((e) => e !== 'NSE' && e !== 'BSE')) {
    throw new ScreenError('universe.exchanges must list one or more of NSE, BSE.');
  }
  const series = u.series ?? ['EQ'];
  if (!Array.isArray(series) || series.length === 0 || series.some((x) => !(SERIES as readonly unknown[]).includes(x))) {
    throw new ScreenError('universe.series must list one or more of EQ, BE, SME.');
  }
  const watchlist = typeof u.watchlist === 'string' && u.watchlist.trim() ? u.watchlist.trim() : null;
  if (source === 'watchlist' && !watchlist) throw new ScreenError('universe.watchlist must name a watchlist.');
  const symbols = u.symbols ?? [];
  if (!Array.isArray(symbols) || symbols.some((s) => typeof s !== 'string' || !s.includes(':'))) {
    throw new ScreenError('universe.symbols must be a list of symbols like zerodha:NSE:RELIANCE.');
  }
  if (source === 'symbols' && symbols.length === 0) throw new ScreenError('universe.symbols needs at least one symbol.');
  if (symbols.length > SCREEN_LIMITS.symbols) throw new ScreenError(`universe.symbols can hold at most ${SCREEN_LIMITS.symbols} symbols.`);
  const maxSymbols = u.max_symbols ?? null;
  if (maxSymbols !== null && (typeof maxSymbols !== 'number' || !Number.isInteger(maxSymbols) || maxSymbols < 1 || maxSymbols > SCREEN_LIMITS.symbols)) {
    throw new ScreenError(`universe.max_symbols must be a whole number between 1 and ${SCREEN_LIMITS.symbols}.`);
  }

  const filtersRaw = input.filters ?? [];
  if (!Array.isArray(filtersRaw)) throw new ScreenError('filters must be a list of conditions.');
  if (filtersRaw.length > SCREEN_LIMITS.filters) throw new ScreenError(`filters can hold at most ${SCREEN_LIMITS.filters} conditions.`);
  const filters = filtersRaw.map((item, i) => {
    try {
      const { left, op, right } = parseCondition(item, `filters[${i}]`);
      return { left, op, right };
    } catch (err) {
      throw new ScreenError(err instanceof SpecError ? err.message : String(err));
    }
  });

  const columnsRaw = input.columns ?? [];
  if (!Array.isArray(columnsRaw)) throw new ScreenError('columns must be a list of features.');
  if (columnsRaw.length > SCREEN_LIMITS.columns) throw new ScreenError(`columns can hold at most ${SCREEN_LIMITS.columns} features.`);
  const columns: string[] = [];
  for (const item of columnsRaw) {
    const key = typeof item === 'string' ? canonicalFeature(item) : null;
    if (!key) throw new ScreenError(`columns: unknown feature ${JSON.stringify(item)}.`);
    if (!columns.includes(key)) columns.push(key);
  }

  let sort: ScreenSpec['sort'] = null;
  if (input.sort !== null && input.sort !== undefined) {
    if (!isRecord(input.sort)) throw new ScreenError('sort must be {column, descending} or null.');
    const column = typeof input.sort.column === 'string' ? canonicalFeature(input.sort.column) : null;
    if (!column) throw new ScreenError(`sort.column: unknown feature ${JSON.stringify(input.sort.column)}.`);
    if (!outputColumns({ columns, filters }).includes(column)) throw new ScreenError(`sort.column must be one of the screen's columns, and ${column} isn't.`);
    sort = { column, descending: input.sort.descending === undefined ? true : Boolean(input.sort.descending) };
  }

  const benchmarkRaw = input.benchmark;
  if (benchmarkRaw !== null && benchmarkRaw !== undefined && (typeof benchmarkRaw !== 'string' || !benchmarkRaw.includes(':'))) {
    throw new ScreenError('benchmark must be a symbol like zerodha:NSE:NIFTY_500, or null.');
  }
  const benchmark = typeof benchmarkRaw === 'string' ? benchmarkRaw.trim() : null;
  if (!benchmark) {
    const needing = outputColumns({ columns, filters }).filter(needsBenchmark);
    if (needing.length) throw new ScreenError(`${needing.join(', ')} compare against an index: set a benchmark (e.g. zerodha:NSE:NIFTY_500).`);
  }

  return {
    version: SCREEN_VERSION,
    name,
    universe: {
      source,
      provider,
      exchanges: [...new Set(exchanges as Exchange[])],
      series: SERIES.filter((x) => (series as unknown[]).includes(x)),
      watchlist,
      symbols: [...new Set((symbols as string[]).map((s) => s.trim()))],
      max_symbols: maxSymbols as number | null,
    },
    filters,
    columns,
    sort,
    benchmark,
  };
}

/** The problem with a screen, or null when it is runnable as far as its shape goes. */
export function screenProblem(input: unknown): string | null {
  try {
    normalizeScreen(input);
    return null;
  } catch (err) {
    return err instanceof ScreenError ? err.message : String(err);
  }
}

/** The first date a run loads, as the engine works it out (`fetch_start`): enough bars before today
 *  for every column to have settled. For the pre-run estimate. */
export function loadFrom(spec: ScreenSpec, today: Date): string {
  const bars = historyBars(spec);
  const days = Math.ceil((bars * 365) / 245) + 10;
  return new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() - days)).toISOString().slice(0, 10);
}

/** Mirrors the engine's `history_bars`, from `features.warmup`: at most what the market-data store
 *  holds (`MAX_HISTORY_BARS`), so a weekly or monthly column reads the store, not the broker. */
export function historyBars(spec: ScreenSpec): number {
  const deepest = Math.max(1, ...outputColumns(spec).map(warmup));
  return Math.min(1200, Math.max(260, 2 * deepest + 10));
}

function warmup(name: string): number {
  return baseWarmup(name) * BARS_PER_INTERVAL[featureInterval(name)];
}

function baseWarmup(name: string): number {
  const key = (canonicalFeature(name) ?? name).split('@')[0];
  if (key.startsWith('macd')) return 35;
  const m = /^([a-z_]+?)_(\d+)$/.exec(key);
  if (!m) return 1;
  const [family, n] = [m[1], Number(m[2])];
  if (family === 'slope_sma' || family === 'slope_ema') return n + 21;
  if (['rsi', 'atr', 'atr_pct', 'adx'].includes(family)) return 3 * n;
  if (family === 'max_drawdown') return 2 * n;
  if (['gain_from_low', 'rvol', 'stoch_d'].includes(family)) return n + 3;
  return n;
}
