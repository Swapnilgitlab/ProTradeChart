/** The answer a Study's result opens with, in plain words: one sentence per headline measure, from
 *  the numbers the engine computed and nothing else. "For the typical stock, “Closed within 3% above
 *  its 21 EMA” held on 24% of days in the 12 months up to and including the event (about 61 of 252).
 *  Middle half: 18%–31%. Random stock-dates: 14% — a large difference (q < 0.001)."
 *
 *  Deterministic, so it says the same thing every time and needs no AI. Drawn as text, never HTML: a
 *  label is the user's (or Claude's) text. A Study with no measures, and every run made before they
 *  existed, gets a shorter answer from its forward returns and findings. Pure. */

import { featureLabel, formatValue, windowLabel } from './metrics';
import { formatMeasure, headlineMeasures, isAnchored, measureUnit, windowPhrase } from './measures';
import { measuredCount, type MeasureResult, type StudyResultData } from './result';
import { describeFinding, effectWord, formatQ, standsOut } from './significance';
import type { Measure } from './spec';
import { headline } from './views';

export interface AnswerLine {
  /** The measure the line is about (its index in the spec), or null for a fallback line. */
  index: number | null;
  text: string;
  /** Which events it covers, when not all of them: "Measured for 50 of 76 events; 20 are too recent…". */
  coverage: string | null;
}

export interface Answer {
  /** No measures: the answer is from snapshots and forward returns, and says so. */
  fallback: boolean;
  lines: AnswerLine[];
}

/** What the comparison group is called, and what the events are called beside it. */
export function groupNames(result: StudyResultData): { group: string; comparison: string | null } {
  const kind = result.summary.control_kind;
  if (kind === 'outcome') return { group: 'Events that reached the outcome', comparison: 'Events that didn’t reach the outcome' };
  if (kind === 'random') return { group: 'Events', comparison: 'Random stock-dates' };
  return { group: 'Events', comparison: null };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

/** "Measured for 50 of 76 events; 20 are too recent for this window, 6 lack enough history." Null when
 *  every event was measured and none was cut off. */
export function coverageLine(m: MeasureResult, events: number): string | null {
  const s = m.events.status;
  const measured = measuredCount(m.events);
  const reasons: string[] = [];
  if (s.too_recent) reasons.push(`${s.too_recent.toLocaleString('en-IN')} ${s.too_recent === 1 ? 'is' : 'are'} too recent for this window`);
  if (s.no_history) reasons.push(`${s.no_history.toLocaleString('en-IN')} ${s.no_history === 1 ? 'lacks' : 'lack'} enough history`);
  if (s.not_found) reasons.push(`${s.not_found.toLocaleString('en-IN')} never reached the window’s start or end`);
  if (s.empty) reasons.push(`${s.empty.toLocaleString('en-IN')} had an empty window`);
  const parts: string[] = [];
  if (measured < events) parts.push(`Measured for ${measured.toLocaleString('en-IN')} of ${plural(events, 'event')}${reasons.length ? `; ${reasons.join(', ')}` : ''}.`);
  if (s.capped && m.stat !== 'length') parts.push(`${plural(s.capped, 'window')} ran to the limit of the search, so ${s.capped === 1 ? 'its value is' : 'their values are'} a lower bound.`);
  return parts.length ? parts.join(' ') : null;
}

function fixedLength(m: Measure): number | null {
  const { start, end } = m.window;
  return 'offset' in start && 'offset' in end ? end.offset - start.offset : null;
}

function comparisonClause(r: MeasureResult, m: Measure, comparison: string | null): string {
  const c = r.control?.median;
  if (!comparison || r.control === null) return '';
  const value = c === null || c === undefined ? (r.control.status.never ? 'most never did' : '—') : formatMeasure(c, measureUnit(m));
  let test = '';
  if (standsOut(r.test)) test = ` — a ${effectWord(r.test!.effect) ?? 'clear'} difference (${formatQ(r.test!.q)})`;
  else if (r.test) test = ' — no clear difference';
  return ` ${comparison}: ${value}${test}.`;
}

function spread(r: MeasureResult, m: Measure): string {
  const { p25, p75 } = r.events;
  if (p25 === null || p75 === null || r.events.count < 4) return '';
  const unit = measureUnit(m);
  return ` Middle half: ${formatMeasure(p25, unit)}–${formatMeasure(p75, unit)}.`;
}

/** The sentence for one measure. */
export function measureSentence(r: MeasureResult, m: Measure, comparison: string | null): string {
  const unit = measureUnit(m);
  const median = r.events.median;
  const M = formatMeasure(median, unit);
  const W = windowPhrase(m.window);
  const X = `“${r.label}”`;
  const length = fixedLength(m);
  const s = r.events.status;
  const measured = measuredCount(r.events);
  if (r.events.count === 0) return `${X} couldn’t be measured for any event ${W}.`;
  let first: string;
  let note = '';
  switch (m.stat) {
    case 'share': {
      const about =
        length !== null && median !== null
          ? ` (about ${Math.round(median * length)} of ${length})`
          : r.window_bars?.median != null
            ? ` (typical window ${Math.round(r.window_bars.median)} days)`
            : '';
      first = `For the typical stock, ${X} held on ${M} of days ${W}${about}.`;
      break;
    }
    case 'count':
      first = `For the typical stock, ${X} held on ${M} days ${W}${length !== null ? ` (of ${length})` : ''}.`;
      break;
    case 'longest_run':
      first = `The typical stock’s longest unbroken run of ${X} ${W} was ${M} days.`;
      break;
    case 'runs':
      first = `For the typical stock, ${X} started ${M} separate time${median === 1 ? '' : 's'} ${W}.`;
      break;
    case 'bars_to_first':
    case 'bars_since_last': {
      const never = s.never;
      if (median === null) {
        first = `More than half (${never} of ${measured}) never saw ${X} ${W}.`;
        break;
      }
      const startsAtEvent = 'offset' in m.window.start && m.window.start.offset === 0;
      const endsAtEvent = 'offset' in m.window.end && m.window.end.offset === 0;
      const when =
        m.stat === 'bars_to_first'
          ? `first held ${M} days ${startsAtEvent ? 'after the event' : 'into the window'}`
          : `last held ${M} days before ${endsAtEvent ? 'the event' : 'the end of the window'}`;
      first = `For the typical stock, ${X} ${when} (${W})${never ? `; ${never} of ${measured} never saw it` : ''}.`;
      break;
    }
    case 'mean':
    case 'min':
    case 'max': {
      const word = { mean: 'average', min: 'lowest', max: 'highest' }[m.stat];
      first = `The typical stock’s ${word} ${featureLabel(m.feature ?? '')} ${W} was ${M}.`;
      break;
    }
    case 'start_value':
      first = `The typical stock’s ${featureLabel(m.feature ?? '')} at the start of the window (${W}) was ${M}.`;
      break;
    case 'end_value':
      first = `The typical stock’s ${featureLabel(m.feature ?? '')} at the end of the window (${W}) was ${M}.`;
      break;
    case 'change':
      first = `The typical stock’s ${featureLabel(m.feature ?? '')} changed by ${M} ${W}.`;
      break;
    case 'return':
      first = `The typical stock returned ${M} ${W}.`;
      break;
    case 'max_gain':
      first = `The typical stock’s biggest rise above its starting close ${W} was ${M}.`;
      break;
    case 'max_drawdown':
      first = `The typical stock’s worst peak-to-trough fall ${W} was ${M} (on closing prices).`;
      break;
    case 'length':
      first = `The typical episode ${W} lasted ${M} trading days.`;
      if (s.capped) note = ` ${s.capped} of ${measured} were still going at the limit of the search and count as that long.`;
      break;
  }
  return `${first}${spread(r, m)}${comparisonClause(r, m, comparison)}${note}`;
}

/** The answer for a result. */
export function answer(result: StudyResultData): Answer {
  const { group, comparison } = groupNames(result);
  const specMeasures = result.spec.measures;
  const measured = result.measures.filter((r) => specMeasures[r.index]);
  if (measured.length) {
    const lead = headlineMeasures(measured.map((r) => ({ r, headline: specMeasures[r.index].headline }))).map((x) => x.r);
    return {
      fallback: false,
      lines: lead.map((r) => ({
        index: r.index,
        text: measureSentence(r, specMeasures[r.index], comparison),
        coverage: coverageLine(r, result.summary.events),
      })),
    };
  }
  const lines: AnswerLine[] = [
    { index: null, text: 'This Study takes snapshots around the event; it doesn’t measure anything over time.', coverage: null },
    { index: null, text: `${headline(result)}.`, coverage: null },
  ];
  const longest = [...result.forward].sort((a, b) => b.window - a.window).find((f) => f.events.median !== null);
  if (longest) {
    const c = longest.control?.median;
    const versus = comparison && c !== null && c !== undefined ? ` (${comparison.toLowerCase()}: ${formatValue(c, 'percent')})` : '';
    lines.push({
      index: null,
      text: `Over the next ${windowLabel(longest.window)}, the median return was ${formatValue(longest.events.median, 'percent')}${versus}.`,
      coverage: null,
    });
  }
  for (const f of result.summary.findings.slice(0, 3)) {
    lines.push({ index: null, text: describeFinding(f, group.toLowerCase(), (comparison ?? 'the comparison group').toLowerCase()), coverage: null });
  }
  return { fallback: true, lines };
}

/** Whether a measure's window has a found endpoint, so its per-stock rows show where it began. */
export const measureHasEpisode = (m: Measure) => isAnchored(m.window);
