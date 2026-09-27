/** Measures as people read them: what a window covers ("in the 12 months up to and including the
 *  event", "from its lowest close of the prior 12 months to the event"), which side of the event it
 *  looks at, and how a measure's values are written.
 *
 *  The window model, in the words `python/protrade/measures.py` uses: a window runs from bar A to bar
 *  B; stats that count days read bars A+1…B; price stats read the closes at A and B. So "12 months up
 *  to the event" includes the event day, and "6 months after" starts the day after it.
 *
 *  Imports only types from `spec.ts` (which uses this file for its interpretation), so there is no
 *  cycle. Pure. */

import type { AnchorPoint, Condition, Endpoint, Measure, MeasureStat } from './spec';
import { describeCondition, featureLabel, featureUnit, formatValue, type Unit } from './metrics';

/** How a measure's values read: a feature's own unit, a share of days, a number of days, a count of
 *  stretches, or percentage points (a change in a fraction). */
export type MeasureUnit = Unit | 'share' | 'bars' | 'count' | 'points';

export type MeasureKind = 'condition' | 'feature' | 'price';

const KIND: Record<MeasureStat, MeasureKind> = {
  share: 'condition',
  count: 'condition',
  longest_run: 'condition',
  runs: 'condition',
  bars_to_first: 'condition',
  bars_since_last: 'condition',
  mean: 'feature',
  min: 'feature',
  max: 'feature',
  start_value: 'feature',
  end_value: 'feature',
  change: 'feature',
  return: 'price',
  max_gain: 'price',
  max_drawdown: 'price',
  length: 'price',
};

export const measureKind = (stat: MeasureStat): MeasureKind => KIND[stat];

/** A stat's name, as a table heading. */
export const STAT_LABEL: Record<MeasureStat, string> = {
  share: 'Share of days',
  count: 'Days',
  longest_run: 'Longest streak (days)',
  runs: 'Separate stretches',
  bars_to_first: 'Days until it first held',
  bars_since_last: 'Days since it last held',
  mean: 'Average',
  min: 'Lowest',
  max: 'Highest',
  start_value: 'At the start',
  end_value: 'At the end',
  change: 'Change',
  return: 'Return',
  max_gain: 'Biggest rise',
  max_drawdown: 'Worst fall',
  length: 'Length (days)',
};

export function measureUnit(m: Pick<Measure, 'stat' | 'feature'>): MeasureUnit {
  switch (m.stat) {
    case 'share':
      return 'share';
    case 'runs':
      return 'count';
    case 'count':
    case 'longest_run':
    case 'bars_to_first':
    case 'bars_since_last':
    case 'length':
      return 'bars';
    case 'return':
    case 'max_gain':
    case 'max_drawdown':
      return 'percent';
    case 'change': {
      const unit = featureUnit(m.feature ?? '');
      return unit === 'percent' ? 'points' : unit;
    }
    default:
      return featureUnit(m.feature ?? '');
  }
}

/** A measure's value as text: `42%` of days, `127` days, `+5.0 pts`, or the feature's own format. */
export function formatMeasure(value: number | null | undefined, unit: MeasureUnit): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (!Number.isFinite(value)) return 'never';
  switch (unit) {
    case 'share':
      return `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`;
    case 'bars':
    case 'count':
      return Number.isInteger(value) ? value.toLocaleString('en-IN') : value.toFixed(1);
    case 'points':
      return `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)} pts`;
    default:
      return formatValue(value, unit);
  }
}

const isAnchor = (e: Endpoint): e is AnchorPoint => 'find' in e;

const SPANS: Record<number, string> = {
  5: '1 week',
  10: '2 weeks',
  21: '1 month',
  42: '2 months',
  63: '3 months',
  126: '6 months',
  189: '9 months',
  252: '12 months',
  504: '2 years',
  756: '3 years',
};

/** A span of bars in words: 252 → "12 months", 40 → "40 trading days". */
export function span(bars: number): string {
  return SPANS[bars] ?? `${bars} trading day${bars === 1 ? '' : 's'}`;
}

function range(e: Endpoint): [number, number] {
  if (!isAnchor(e)) return [e.offset, e.offset];
  return e.direction === 'before' ? [-e.within, 0] : [1, e.within];
}

/** Which side of the event a window looks at: `before` when it can't reach past the event bar,
 *  `after` when it can't start before it; the engine's `side`. */
export function windowSide(w: Measure['window']): 'before' | 'after' | 'spanning' {
  if (range(w.end)[1] <= 0) return 'before';
  if (range(w.start)[0] >= 0) return 'after';
  return 'spanning';
}

export const isAnchored = (w: Measure['window']) => isAnchor(w.start) || isAnchor(w.end);

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

/** Conditions as a quoted phrase: “Close < SMA 50 and RSI 14 > 50”. */
export function conditionsPhrase(conditions: readonly Condition[]): string {
  return `“${conditions.map(describeCondition).join(' and ')}”`;
}

function pointPhrase(e: Endpoint): string {
  if (!isAnchor(e)) {
    if (e.offset === 0) return 'the event';
    return `${span(Math.abs(e.offset))} ${e.offset < 0 ? 'before' : 'after'} the event`;
  }
  const around = e.direction === 'before' ? 'prior' : 'next';
  if (e.find === 'lowest' || e.find === 'highest') return `its ${e.find} ${lowerFirst(featureLabel(e.feature ?? ''))} of the ${around} ${span(e.within)}`;
  return `the ${e.find} day ${conditionsPhrase(e.conditions)} held ${e.direction} the event (within ${span(e.within)})`;
}

/** What a window covers, in words. */
export function windowPhrase(w: Measure['window']): string {
  const { start, end } = w;
  if (!isAnchor(start) && !isAnchor(end)) {
    const [a, b] = [start.offset, end.offset];
    if (b === 0) return `in the ${span(-a)} up to and including the event`;
    if (a === 0) return `in the ${span(b)} after the event`;
    if (b < 0) return `from ${span(-a)} to ${span(-b)} before the event`;
    if (a > 0) return `from ${span(a)} to ${span(b)} after the event`;
    return `from ${span(-a)} before to ${span(b)} after the event`;
  }
  if (!isAnchor(start) && start.offset === 0 && isAnchor(end) && end.find === 'first' && end.direction === 'after') {
    return `from the event until ${conditionsPhrase(end.conditions)} first held (looking up to ${span(end.within)} ahead)`;
  }
  if (isAnchor(start) && start.find === 'last' && start.direction === 'before' && !isAnchor(end) && end.offset === 0) {
    return `from the last day ${conditionsPhrase(start.conditions)} held (looking back up to ${span(start.within)}) to the event`;
  }
  return `from ${pointPhrase(start)} to ${pointPhrase(end)}`;
}

/** One line for the Study's interpretation: “Closed within 3% above its 21 EMA” — share of days, in
 *  the 12 months up to and including the event; days when “…”. */
export function measureLine(m: Measure): string {
  const what =
    measureKind(m.stat) === 'condition' ? `; days when ${conditionsPhrase(m.conditions)}` : m.feature ? `; of ${featureLabel(m.feature)}` : '';
  return `“${m.label}” — ${STAT_LABEL[m.stat].toLowerCase()}, ${windowPhrase(m.window)}${what}${m.headline ? ' (headline)' : ''}`;
}

/** The measures the answer leads with: those flagged as headline, or else the first one. */
export function headlineMeasures<T extends { headline: boolean }>(measures: readonly T[]): T[] {
  const flagged = measures.filter((m) => m.headline);
  return flagged.length ? flagged : measures.slice(0, 1);
}
