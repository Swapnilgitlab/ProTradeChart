/** The AI Study Builder's side of the conversation with Claude (the calls themselves are made in
 *  Rust, `src-tauri/src/ai/`, with the user's own key).
 *
 *  What is sent: `specReference()` (the Study Specification's fields and the feature grammar, built
 *  from `metrics.ts` so it can't drift from what `normalizeSpec` accepts), which includes `SPEC_SCHEMA`
 *  as text: the shape Claude writes a spec in. (It is not the request's output schema — that one is
 *  compiled into a grammar, and a spec-sized schema is refused — so a spec comes back as JSON text.) What comes back is untrusted: `parseDraft` re-validates the spec
 *  with `normalizeSpec` and caps every string, and nothing here or downstream runs it — the user
 *  reviews it and presses Run Study. `explainSummary` is what an explanation is given: a result's
 *  counts, tests and medians, never its events or prices. Pure. */

import { answer } from './answer';
import { windowPhrase, windowSide } from './measures';
import { ALIASES, FAMILIES, MAX_WINDOW, PLAIN, type Family } from './metrics';
import type { StudyResultData, TestResult } from './result';
import { FINDS, LIMITS, MEASURE_STATS, normalizeSpec, OPS, SERIES, SpecError, type StudySpec } from './spec';

/** What each family computes. A `Record` over every family, so a new one can't be left out. */
export const FAMILY_MEANING: Record<Family, string> = {
  return: 'close / close N bars earlier − 1',
  gain_from_low: 'close / lowest close of the last N+1 bars − 1',
  sma: 'simple moving average of close',
  ema: 'exponential moving average of close',
  dist_sma: 'close / sma_N − 1',
  dist_ema: 'close / ema_N − 1',
  slope_sma: 'sma_N / sma_N 21 bars earlier − 1',
  slope_ema: 'ema_N / ema_N 21 bars earlier − 1',
  rsi: "Wilder's RSI, 0–100",
  atr: "Wilder's average true range, in price",
  atr_pct: 'atr_N / close',
  high: 'highest high of the last N bars (including this one)',
  low: 'lowest low of the last N bars (including this one)',
  prior_high: 'high_N as of the previous bar (for breakouts: close crosses_above prior_high_N)',
  prior_low: 'low_N as of the previous bar',
  dist_high: 'close / high_N − 1 (≤ 0)',
  dist_low: 'close / low_N − 1 (≥ 0)',
  range: 'high_N / low_N − 1',
  avg_volume: 'average volume (shares)',
  rvol: 'volume / average volume of the N bars before',
  avg_traded_value: 'average of close × volume, rupees a day',
  volatility: 'annualised standard deviation of daily returns',
  drawdown: 'close / highest close of the last N bars − 1 (≤ 0)',
  max_drawdown: 'worst peak-to-trough fall within the last N bars (≤ 0)',
  rs: "return_N minus the benchmark index's return over N bars (needs a benchmark)",
  adx: 'average directional index, 0–100',
  bb_pctb: 'Bollinger %B of N-bar bands at 2 standard deviations: 0 = lower band, 1 = upper',
  bb_width: 'Bollinger band width / middle band',
  stoch_k: 'Stochastic %K, 0–100',
  stoch_d: '3-bar average of stoch_k_N',
};

export const PLAIN_MEANING: Record<(typeof PLAIN)[number], string> = {
  open: "the bar's open",
  high: "the bar's high",
  low: "the bar's low",
  close: "the bar's close",
  volume: "the bar's volume",
  macd: 'MACD (12, 26) as a fraction of close',
  macd_signal: 'MACD signal line (9) as a fraction of close',
  macd_hist: 'MACD − signal, as a fraction of close',
};

/** The Study Specification and its feature grammar, for Claude. */
export function specReference(): string {
  const families = FAMILIES.map((f) => `- ${f}_N: ${FAMILY_MEANING[f]}`).join('\n');
  const plain = PLAIN.map((p) => `- ${p}: ${PLAIN_MEANING[p]}`).join('\n');
  const aliases = Object.entries(ALIASES)
    .map(([alias, name]) => `${alias} = ${name}`)
    .join(', ');
  return `All windows are counted in daily bars: 5 ≈ 1 week, 21 ≈ 1 month, 63 ≈ 3 months, 126 ≈ 6 months, 252 ≈ 1 year.
Returns, distances, slopes and volatilities are fractions: 0.25 is +25%, 1.0 is +100%, -0.1 is -10%.

## Fields
- version: always 1.
- name: a short title (at most 120 characters). description: one or two sentences of what the Study asks.
- template: null.
- universe.source: "instruments" (every listed stock of the exchanges), "watchlist" (universe.watchlist names one of the user's watchlists) or "symbols" (universe.symbols lists symbols written provider:EXCHANGE:TICKER, e.g. zerodha:NSE:RELIANCE).
- universe.provider: "zerodha" or "dhan". universe.exchanges: one or more of "NSE", "BSE" (NSE alone unless asked).
- universe.series: which listings count as stocks, one or more of ${SERIES.map((s) => `"${s}"`).join(', ')} (EQ: ordinary shares; BE: trade-for-trade; SME: the SME platforms). ["EQ"] unless asked.
- universe.market_cap_min: always null (no market-cap data exists).
- universe.min_avg_traded_value: rupees a day, the 50-day average of close × volume at the event, or null. 1e7 is ₹1 Cr.
- universe.min_price: rupees, or null. universe.max_symbols: null (the user can choose a trial run later).
- period.start: first date an event may fall on, YYYY-MM-DD. period.end: last date, or null for the latest data.
- event.conditions: 1 to ${LIMITS.conditions} conditions that must all hold. The event is the first bar on which they all hold after a bar on which they didn't.
- event.label: a short name for the event. event.cooldown_days: bars before the same stock can have another event (252 for once-a-year events like doubling; shorter for frequent ones).
- A condition is {left, op, right, label}: left is a feature name, op is one of ${OPS.map((o) => `"${o}"`).join(', ')}, right is a number or another feature name. crosses_above/crosses_below hold on the bar that crosses. label may be null.
- pre_event_filters: up to ${LIMITS.filters} conditions, each with at = bars before the event it is judged at (0: on the event bar). A filter judged before the event uses only what was known then.
- lookback_windows: bars before the event at which metrics are observed, 1 to ${LIMITS.windows} values of at most ${MAX_WINDOW}, e.g. [252, 126, 63, 21].
- forward_windows: bars after the event whose returns are measured, 1 to ${LIMITS.windows} values, e.g. [21, 63, 126, 252].
- metrics: up to ${LIMITS.metrics} feature names measured at each observation point (and at the event); [] when measures alone answer the question. Prefer distances (dist_ema_200) over raw averages (ema_200), which can't be compared across stocks.
- characteristics: up to ${LIMITS.characteristics} yes/no conditions counted at each observation point, each with a short label (e.g. {"left": "close", "op": ">", "right": "ema_200", "label": "Above 200 EMA"}).
- question: the trader's question, in plain words (at most ${LIMITS.question} characters). It is shown above the answer.

## Snapshots and measures
metrics and characteristics are snapshots: each reads ONE bar, at an observation point (the event, or N bars before or after it). They answer "what did the stock look like on that day?" and "what share of events had X on that day?".
measures read a WINDOW of bars and give ONE NUMBER PER EVENT: on how many days (or what share of days) something held, the longest streak, how many separate times it started, the average/lowest/highest of a feature, the return, biggest rise or worst fall, how long an episode lasted. Any question about the journey to an event, its aftermath, or a stretch between two found days needs measures: "on how many days in the 12 months before…", "how long did the run take", "how far did it fall afterwards", "how many pullbacks to the 21 EMA". Never answer such a question with snapshots or characteristics sampled at observation points: that measures something else.
A Study needs at least one metric or one measure; metrics may be [] when measures answer the question.

- measures: up to ${LIMITS.measures} objects {label, stat, conditions, feature, window, headline}.
- label: short and specific, e.g. "Closed within 3% above its 21 EMA".
- stat: one of ${MEASURE_STATS.map((s) => `"${s}"`).join(', ')}.
  - With conditions (1–${LIMITS.measureConditions} conditions that must ALL hold on a day, so a band is two conditions: dist_ema_21 >= 0 and dist_ema_21 <= 0.03): share (fraction of the window's days they held), count (days they held), longest_run (longest streak of consecutive days), runs (separate stretches in which they held, e.g. pullbacks into a zone), bars_to_first (days from the window's start to the first day they held; "never" if they didn't), bars_since_last (days from the last day they held to the window's end).
  - With feature (one feature name): mean, min, max (over the window's days), start_value, end_value, change (end minus start).
  - Price, no inputs: return (close at the end ÷ close at the start − 1), max_gain (best close above the start's), max_drawdown (worst peak-to-trough fall of the close within the window), length (days in the window; only for a window with a found endpoint).
  - Unused inputs are [] (conditions) and null (feature).
- window: {start, end}. A window runs from bar A to bar B: counting stats read the days after A up to and including B; price stats read the closes at A and B. Each endpoint is either:
  - {"offset": k}: k bars from the event bar (negative before, 0 the event, positive after), |k| ≤ ${MAX_WINDOW}.
  - {"find", "feature", "conditions", "direction", "within", "if_not_found"}: a day found near the event, searched in the "within" bars before the event (direction "before", up to and including the event bar) or after it ("after"). find is "lowest" or "highest" (of feature; conditions []) or "first" or "last" (the first/last day conditions all held; feature null). if_not_found: "cap" (use the far edge of the search; the value is then a lower bound) or "skip" (leave that event unmeasured).
- headline: true for the 1–${LIMITS.headlines} measures that answer the question; they are stated first in the answer.
- Examples of windows:
  - The 12 months up to and including the event: {"start": {"offset": -252}, "end": {"offset": 0}}
  - The 6 months after the event: {"start": {"offset": 0}, "end": {"offset": 126}}
  - From the stock's lowest close of the prior year to the event (the run-up): {"start": {"find": "lowest", "feature": "close", "conditions": [], "direction": "before", "within": 252, "if_not_found": "cap"}, "end": {"offset": 0}}
  - From the event until the first close below the 50 SMA, looking a year ahead (how long the trend lasted): {"start": {"offset": 0}, "end": {"find": "first", "feature": null, "conditions": [{"left": "close", "op": "<", "right": "sma_50", "label": null}], "direction": "after", "within": 252, "if_not_found": "cap"}}
- Example measure: {"label": "Closed within 3% above its 21 EMA", "stat": "count", "conditions": [{"left": "dist_ema_21", "op": ">=", "right": 0, "label": null}, {"left": "dist_ema_21", "op": "<=", "right": 0.03, "label": null}], "feature": null, "window": {"start": {"offset": -252}, "end": {"offset": 0}}, "headline": true}

## More fields
- benchmark: an index symbol for rs_N features, e.g. "zerodha:NSE:NIFTY_500"; null when no rs_ feature is used.
- outcome: null, or {window, min_return}: split the events into those whose price rose at least min_return within window bars after the event, and those that didn't, and compare the two instead of using random dates.
- control_group: {enabled, samples_per_event (1–10), seed}. Enabled with 2 samples per event and seed 42 unless asked: random non-event dates of the same stocks, filtered the same way.
- output.max_events: 5000 unless asked (at most ${LIMITS.maxEvents}).

## Features
A feature is a family with a window in bars, family_N (N from 1 to ${MAX_WINDOW}), or a plain name.
${families}
Plain names:
${plain}
Aliases (accepted, rewritten to the name on the right): ${aliases}.

## JSON schema
A Study Specification, as JSON Schema:
${JSON.stringify(SPEC_SCHEMA)}`;
}

const STRING = { type: 'string' } as const;
const NUMBER = { type: 'number' } as const;
const INTEGER = { type: 'integer' } as const;
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties: Record<string, object>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const CONDITION = object({ left: STRING, op: { type: 'string', enum: [...OPS] }, right: { anyOf: [NUMBER, STRING] }, label: nullable(STRING) });
const ENDPOINT = {
  anyOf: [
    object({ offset: INTEGER }),
    object({
      find: { type: 'string', enum: [...FINDS] },
      feature: nullable(STRING),
      conditions: { type: 'array', items: CONDITION },
      direction: { type: 'string', enum: ['before', 'after'] },
      within: INTEGER,
      if_not_found: { type: 'string', enum: ['skip', 'cap'] },
    }),
  ],
};
const MEASURE = object({
  label: STRING,
  stat: { type: 'string', enum: [...MEASURE_STATS] },
  conditions: { type: 'array', items: CONDITION },
  feature: nullable(STRING),
  window: object({ start: ENDPOINT, end: ENDPOINT }),
  headline: { type: 'boolean' },
});

/** A Study Specification as JSON Schema, sent to Claude as reference text (no numeric or length
 *  limits: `normalizeSpec` enforces those). */
export const SPEC_SCHEMA = object({
  version: { type: 'integer', enum: [1] },
  name: STRING,
  description: STRING,
  question: STRING,
  template: nullable(STRING),
  universe: object({
    source: { type: 'string', enum: ['instruments', 'watchlist', 'symbols'] },
    provider: { type: 'string', enum: ['zerodha', 'dhan'] },
    exchanges: { type: 'array', items: { type: 'string', enum: ['NSE', 'BSE'] } },
    series: { type: 'array', items: { type: 'string', enum: [...SERIES] } },
    watchlist: nullable(STRING),
    symbols: { type: 'array', items: STRING },
    market_cap_min: { type: 'null' },
    min_avg_traded_value: nullable(NUMBER),
    min_price: nullable(NUMBER),
    max_symbols: nullable(INTEGER),
  }),
  period: object({ start: { type: 'string', format: 'date' }, end: nullable({ type: 'string', format: 'date' }) }),
  event: object({ label: STRING, conditions: { type: 'array', items: CONDITION }, cooldown_days: INTEGER }),
  pre_event_filters: {
    type: 'array',
    items: object({ left: STRING, op: { type: 'string', enum: [...OPS] }, right: { anyOf: [NUMBER, STRING] }, label: nullable(STRING), at: INTEGER }),
  },
  lookback_windows: { type: 'array', items: INTEGER },
  forward_windows: { type: 'array', items: INTEGER },
  metrics: { type: 'array', items: STRING },
  characteristics: { type: 'array', items: CONDITION },
  measures: { type: 'array', items: MEASURE },
  benchmark: nullable(STRING),
  outcome: nullable(object({ window: INTEGER, min_return: NUMBER })),
  control_group: object({ enabled: { type: 'boolean' }, samples_per_event: INTEGER, seed: INTEGER }),
  output: object({ max_events: INTEGER }),
});

const MAX_REPLY = 2_000;
const MAX_NOTE = 500;
const MAX_NOTES = 12;
const MAX_EXPLANATION = 12_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function notes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .slice(0, MAX_NOTES)
    .map((v) => clip(v, MAX_NOTE));
}

/** One of Claude's answers to a question or a revision. */
export interface Draft {
  reply: string;
  /** The proposed spec, valid by `normalizeSpec`; null when there is none or it isn't valid. */
  spec: StudySpec | null;
  /** Why a proposed spec was refused, in `normalizeSpec`'s words. */
  problem: string | null;
  assumptions: string[];
  unavailable: string[];
}

/** Reads Claude's answer to `ai_draft_study`. Never throws: a bad answer is a Draft with a problem. */
export function parseDraft(answer: unknown): Draft {
  if (!isRecord(answer)) {
    return { reply: '', spec: null, problem: "Claude's answer wasn't in the expected form.", assumptions: [], unavailable: [] };
  }
  const draft: Draft = {
    reply: typeof answer.reply === 'string' ? clip(answer.reply, MAX_REPLY) : '',
    spec: null,
    problem: null,
    assumptions: notes(answer.assumptions),
    unavailable: notes(answer.unavailable),
  };
  // The spec arrives as JSON text (see "output schemas" in `ai/prompts.rs`); an object is read too.
  let raw: unknown = answer.spec;
  if (typeof raw === 'string') {
    if (!raw.trim()) return draft;
    try {
      raw = JSON.parse(raw);
    } catch {
      draft.problem = "Claude's spec wasn't valid JSON.";
      return draft;
    }
  }
  if (raw !== null && raw !== undefined) {
    try {
      // The template is the app's to set; a proposal never claims to be one.
      draft.spec = { ...normalizeSpec(raw), template: null };
    } catch (e) {
      draft.problem = e instanceof SpecError ? e.message : "Claude's spec couldn't be read.";
    }
  }
  return draft;
}

export interface Explanation {
  paragraphs: string[];
  caveats: string[];
}

/** Reads Claude's answer to `ai_explain_result` as plain paragraphs. */
export function parseExplanation(answer: unknown): Explanation | null {
  if (!isRecord(answer) || typeof answer.explanation !== 'string' || !answer.explanation.trim()) return null;
  const paragraphs = clip(answer.explanation, MAX_EXPLANATION)
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
  return { paragraphs, caveats: notes(answer.caveats) };
}

/** A conversation turn as `ai_draft_study` takes it. */
export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

/** Four significant figures: enough to explain, and keeps the request small. */
function round(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return Number(v.toPrecision(4));
}

function test(t: TestResult | null) {
  if (!t) return null;
  return { p: round(t.p), q: round(t.q), effect: round(t.effect), diff: round(t.diff), low: round(t.low), high: round(t.high), n_events: t.n_events, n_control: t.n_control };
}

/** What an explanation is given: counts, tests and medians. No event rows, symbols or prices. */
export function explainSummary(result: StudyResultData): Record<string, unknown> {
  const m = result.meta;
  const s = result.summary;
  return {
    question: result.spec.question || null,
    // The app's own plain-language answer, built from the headline measures (or, with none, from
    // forward returns and findings). An explanation starts from it.
    answer: answer(result).lines.map((l) => (l.coverage ? `${l.text} ${l.coverage}` : l.text)),
    offsets_note: 'offset is bars relative to the event: -63 is 63 bars (about 3 months) before, 0 is the event bar',
    measures: result.measures.map((r) => {
      const spec = result.spec.measures[r.index];
      return {
        label: r.label,
        stat: r.stat,
        headline: spec?.headline ?? false,
        window: spec ? windowPhrase(spec.window) : null,
        side: spec ? windowSide(spec.window) : null,
        events_median: round(r.events.median),
        events_iqr: [round(r.events.p25), round(r.events.p75)],
        events_status: r.events.status,
        comparison_median: round(r.control?.median),
        test: test(r.test),
      };
    }),
    summary: {
      events: s.events,
      unique_symbols: s.unique_symbols,
      first_event: s.first_event,
      last_event: s.last_event,
      median_avg_traded_value: round(s.median_avg_traded_value),
      control_kind: s.control_kind,
      control_samples: s.control_samples,
      outcome: s.outcome,
      findings: s.findings.map((f) => ({ ...f, test: test(f.test) })),
    },
    data: {
      source: m.data_source,
      from: m.data_from,
      through: m.data_through,
      symbols_loaded: m.symbols_loaded,
      symbols_failed: m.symbols_failed,
      symbols_short_history: m.symbols_short_history,
    },
    measurements: result.stats.map((r) => ({
      metric: r.metric,
      offset: r.offset,
      events_median: round(r.events.median),
      events_iqr: [round(r.events.p25), round(r.events.p75)],
      events_count: r.events.count,
      comparison_median: round(r.control?.median),
      test: test(r.test),
    })),
    characteristics: result.characteristics.map((c) => ({
      label: c.label,
      offset: c.offset,
      events_share: round(c.events.share),
      comparison_share: round(c.control?.share),
      test: test(c.test),
    })),
    forward: result.forward.map((f) => ({
      window: f.window,
      events_median_return: round(f.events.median),
      events_share_positive: round(f.events.positive.share),
      events_max_drawdown_median: round(f.events.max_drawdown_median),
      comparison_median_return: round(f.control?.median),
      test: test(f.test),
    })),
  };
}

/** What a streaming answer is doing, for a busy button: "Thinking…", "Writing… 2.1k characters". */
export function progressText(progress: { stage: 'thinking' | 'writing'; chars: number } | null): string {
  if (!progress || progress.stage === 'thinking') return 'Thinking…';
  const chars = progress.chars < 1000 ? `${progress.chars}` : `${(progress.chars / 1000).toFixed(1)}k`;
  return `Writing… ${chars} characters`;
}
