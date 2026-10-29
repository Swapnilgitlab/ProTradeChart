/** Study Data Readiness: before a Study runs, what it needs and whether the app has it.
 *
 *  Nothing here invents, estimates or substitutes data. A field no source supplies is reported
 *  unavailable; when the Study depends on it the run is blocked, and where there is an honest
 *  alternative (a liquidity floor instead of a market-cap floor) it is offered, never applied
 *  silently. What can only be known per symbol — how far back each one's history goes — is
 *  checked by the engine as it runs and reported with the result. Pure. */

import { INDIA, splitSymbol } from '../lib/symbols';
import { measureFeatures, measureReach, requiredFeatures, type Condition, type StudySpec } from './spec';
import { DEFAULT_MIN_TRADED_VALUE } from './templates';

export type ReadinessStatus = 'available' | 'unavailable' | 'warning' | 'unused';

export type ReadinessFix = 'use_traded_value' | 'drop_benchmark' | 'trial_run';

export interface ReadinessItem {
  field: string;
  status: ReadinessStatus;
  detail: string;
  /** The Study can't run until this is dealt with. */
  blocking: boolean;
  fix?: { id: ReadinessFix; label: string };
}

export interface ReadinessFacts {
  /** The data sources a Study can read and whether each is set up and switched on. */
  /** Each symbol namespace (`india`, `csv`), whether it can be read now, and what to call its source. */
  providers: readonly { id: string; usable: boolean; label?: string }[];
  pythonReady: boolean;
  pythonMessage?: string | null;
  watchlists: readonly string[];
  /** Today, `YYYY-MM-DD`. */
  today: string;
  /** What loading the universe will cost (`study_estimate`), once known. */
  estimate?: UniverseEstimate | null;
}

/** The backend's `StudyEstimate`. */
export interface UniverseEstimate {
  symbols: number;
  stored: number;
  requests: number;
  quoteRequests: number;
  seconds: number;
  listingsSkipped: number;
}

/** Symbols in a quick trial run. */
export const TRIAL_SYMBOLS = 100;
/** Above this many minutes of fetching, a trial run is offered. */
const LONG_FETCH_MINUTES = 5;

/** A duration as people read it: "about 40 s", "about 12 min", "about 1 h 20 min". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `about ${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  return `about ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** What loading the rest of the universe costs: "2,000 broker requests, about 12 min", "1 quick
 *  quote check, about 1 s", both joined, or "nothing to fetch" when the store already covers it. */
export function formatCost(e: Pick<UniverseEstimate, 'requests' | 'quoteRequests' | 'seconds'>): string {
  const parts: string[] = [];
  if (e.requests) parts.push(`${e.requests.toLocaleString()} broker request${e.requests === 1 ? '' : 's'}`);
  if (e.quoteRequests) parts.push(`${e.quoteRequests.toLocaleString()} quick quote check${e.quoteRequests === 1 ? '' : 's'}`);
  return parts.length ? `${parts.join(' and ')}, ${formatDuration(e.seconds)}` : 'nothing to fetch';
}

export interface Readiness {
  items: ReadinessItem[];
  /** Trading days of history needed before the first event date. */
  historyBars: number;
  /** The first date the Study loads, and the span of years it covers. */
  loadFrom: string;
  years: number;
  /** Share of the data the Study depends on that the app has, 0–100. */
  score: number;
  ready: boolean;
  notes: string[];
}

const WARMUP: Record<string, (n: number) => number> = {
  slope_sma: (n) => n + 21,
  slope_ema: (n) => n + 21,
  rsi: (n) => 3 * n,
  atr: (n) => 3 * n,
  atr_pct: (n) => 3 * n,
  adx: (n) => 3 * n,
  max_drawdown: (n) => 2 * n,
  gain_from_low: (n) => n + 3,
  rvol: (n) => n + 3,
  stoch_d: (n) => n + 3,
};

/** Bars a feature needs before it has a value; the engine's `features.warmup`. */
export function warmup(name: string): number {
  const i = name.lastIndexOf('_');
  const n = Number(name.slice(i + 1));
  if (!Number.isInteger(n)) return name.startsWith('macd') ? 35 : 1;
  const family = name.slice(0, i);
  return WARMUP[family]?.(n) ?? n;
}

/** Bars needed before the first event date for every measurement to have a value; the engine's `history_bars`. */
export function historyBars(spec: StudySpec): number {
  const deepest = Math.max(...requiredFeatures(spec).map(warmup));
  const filters = Math.max(0, ...spec.pre_event_filters.map((f) => f.at));
  const reach = Math.max(...spec.lookback_windows, ...spec.measures.map(measureReach));
  return reach + Math.max(deepest, filters) + 5;
}

/** The first date loaded: the engine's `fetch_start`. */
export function loadFrom(spec: StudySpec): string {
  const start = new Date(`${spec.period.start}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (Math.ceil((historyBars(spec) * 365) / 245) + 10));
  return start.toISOString().slice(0, 10);
}

function providersOf(spec: StudySpec): string[] {
  const u = spec.universe;
  if (u.source === 'instruments') return [u.provider];
  if (u.source === 'symbols') return [...new Set(u.symbols.map((s) => splitSymbol(s).provider))];
  return []; // a watchlist's symbols are only known when it runs
}

export function checkReadiness(spec: StudySpec, facts: ReadinessFacts): Readiness {
  const items: ReadinessItem[] = [];
  const notes: string[] = [];
  const usable = new Set(facts.providers.filter((p) => p.usable).map((p) => p.id));
  const label = (id: string) => facts.providers.find((p) => p.id === id)?.label ?? id;

  items.push(
    facts.pythonReady
      ? { field: 'Python', status: 'available', detail: 'Ready to run the Study engine', blocking: false }
      : { field: 'Python', status: 'unavailable', detail: facts.pythonMessage ?? 'Set up Python in the Python tab first.', blocking: true },
  );

  const sources = providersOf(spec);
  const unsupported = sources.filter((p) => p !== INDIA);
  const missing = sources.filter((p) => p === INDIA && !usable.has(p));
  if (spec.universe.source === 'watchlist') {
    const known = facts.watchlists.some((w) => w.toLowerCase() === (spec.universe.watchlist ?? '').toLowerCase());
    items.push({
      field: 'Universe',
      status: known ? 'available' : 'unavailable',
      detail: known ? `Watchlist "${spec.universe.watchlist}"` : `There is no watchlist called "${spec.universe.watchlist}".`,
      blocking: !known,
    });
  }
  const priceStatus: ReadinessItem =
    unsupported.length > 0
      ? { field: 'OHLC', status: 'unavailable', detail: `Studies read Indian market data only, not ${unsupported.join(', ')}.`, blocking: true }
      : missing.length > 0
        ? { field: 'OHLC', status: 'unavailable', detail: `${missing.map(label).join(' and ')} isn't set up and switched on (Data providers).`, blocking: true }
        : { field: 'OHLC', status: 'available', detail: 'Daily bars, as the broker supplies them (adjusted for corporate actions at source)', blocking: false };
  items.push(priceStatus);
  items.push({ ...priceStatus, field: 'Volume', detail: priceStatus.status === 'available' ? 'Part of the daily bars' : priceStatus.detail });

  const capAsked = spec.universe.market_cap_min !== null;
  items.push({
    field: 'Market cap',
    status: 'unavailable',
    detail: capAsked
      ? 'No data source supplies market cap, current or historical, so a market-cap filter can’t be applied.'
      : 'Not supplied by any data source: events carry no market cap.',
    blocking: capAsked,
    fix: capAsked ? { id: 'use_traded_value', label: 'Filter on average traded value instead' } : undefined,
  });
  items.push({ field: 'Sector', status: 'unavailable', detail: 'No sector or industry metadata: results aren’t grouped by sector.', blocking: false });

  if (spec.benchmark) {
    const provider = splitSymbol(spec.benchmark).provider;
    const ok = usable.has(provider);
    items.push({
      field: 'Index data',
      status: ok ? 'available' : 'unavailable',
      detail: ok ? `${spec.benchmark}, for relative strength` : `${label(provider)} isn't set up, so relative strength would be blank.`,
      blocking: false,
      fix: ok ? undefined : { id: 'drop_benchmark', label: 'Remove the benchmark and relative strength' },
    });
  } else {
    items.push({ field: 'Index data', status: 'unused', detail: 'No benchmark: relative strength isn’t measured.', blocking: false });
  }

  items.push({
    field: 'Point-in-time universe',
    status: 'warning',
    detail:
      spec.universe.source === 'instruments'
        ? 'Historical universe data is incomplete: the universe is today’s instrument list, so delisted stocks are missing. Results may contain survivorship bias.'
        : 'The universe is a list chosen today, so it may carry hindsight (survivorship or selection bias).',
    blocking: false,
  });

  if (facts.estimate) {
    const e = facts.estimate;
    const long = e.seconds / 60 > LONG_FETCH_MINUTES;
    const parts = [
      `${e.symbols.toLocaleString()} symbol${e.symbols === 1 ? '' : 's'}`,
      e.listingsSkipped ? `${e.listingsSkipped.toLocaleString()} other listings left out (bonds, SGBs, funds, second listings)` : null,
      `${e.stored.toLocaleString()} already loaded`,
      formatCost(e),
    ].filter(Boolean);
    items.push({
      field: 'Data to load',
      status: e.symbols === 0 ? 'unavailable' : long ? 'warning' : 'available',
      detail:
        e.symbols === 0
          ? 'No stocks in this universe. Update the instrument list in Data providers, or widen the listings.'
          : `${parts.join('; ')}.`,
      blocking: e.symbols === 0 && spec.universe.source === 'instruments',
      fix:
        long && spec.universe.max_symbols === null
          ? { id: 'trial_run', label: `Try it on the first ${TRIAL_SYMBOLS} symbols first` }
          : undefined,
    });
  }
  if (spec.universe.source === 'instruments' && spec.universe.exchanges.includes('BSE')) {
    notes.push(
      'BSE lists several times as many companies as NSE, most of them small and thinly traded: including it multiplies the ' +
        'first run’s time. A company listed on both is studied once.',
    );
  }

  const bars = historyBars(spec);
  const from = loadFrom(spec);
  const until = spec.period.end ?? facts.today;
  const years = Math.max(0, (Date.parse(until) - Date.parse(from)) / (365.25 * 86_400_000));
  notes.push(
    `Required history: from ${from} (${bars} trading days before the first event date), about ${years.toFixed(1)} years in all. ` +
      'How far back each symbol’s history really goes is checked as the Study runs; the result reports any with less.',
  );
  if (!facts.estimate && spec.universe.source === 'instruments' && spec.universe.max_symbols === null) {
    notes.push(
      'The first run over a whole exchange fetches every symbol’s history at the broker’s rate limit, which can take tens of minutes. ' +
        'What is fetched is kept, so later runs are quick. Set a symbol limit for a quick trial first.',
    );
  }

  const counted = items.filter((i) => i.blocking || i.field === 'OHLC' || i.field === 'Volume' || (i.field === 'Index data' && i.status !== 'unused'));
  const have = counted.filter((i) => i.status === 'available').length;
  const score = counted.length ? Math.round((100 * have) / counted.length) : 100;
  return { items, historyBars: bars, loadFrom: from, years, score, ready: !items.some((i) => i.blocking), notes };
}

/** Applies an alternative the readiness check offered. The user chooses it; it is never automatic. */
export function applyFix(spec: StudySpec, fix: ReadinessFix): StudySpec {
  const next = structuredClone(spec);
  if (fix === 'use_traded_value') {
    next.universe.market_cap_min = null;
    next.universe.min_avg_traded_value ??= DEFAULT_MIN_TRADED_VALUE;
  } else if (fix === 'trial_run') {
    next.universe.max_symbols = TRIAL_SYMBOLS;
  } else if (fix === 'drop_benchmark') {
    next.benchmark = null;
    const usesRs = (c: { left: string; right: Condition['right'] }) => c.left.startsWith('rs_') || (typeof c.right === 'string' && c.right.startsWith('rs_'));
    next.metrics = next.metrics.filter((m) => !m.startsWith('rs_'));
    next.characteristics = next.characteristics.filter((c) => !usesRs(c));
    next.pre_event_filters = next.pre_event_filters.filter((c) => !usesRs(c));
    next.measures = next.measures.filter((m) => !measureFeatures(m).some((f) => f.startsWith('rs_')));
  }
  return next;
}
