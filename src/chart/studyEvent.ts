/** Opening a Study's event on a chart: the chart framed around the event date, with a mark on the
 *  event's bar. The framing is pure and tested; `showStudyEvent` applies it to a live chart. */

import type { TimelineMark, Vela } from '@luxalgo/vela';

export interface StudyEvent {
  /** Long-form symbol, `zerodha:NSE:ABC`. */
  symbol: string;
  /** The event's date, `YYYY-MM-DD`. */
  date: string;
  /** What happened, for the mark's tooltip. */
  label: string;
}

const DAY_MS = 86_400_000;
/** About a year before the event (the longest usual look-back) and nine months after. */
const BEFORE_DAYS = 380;
const AFTER_DAYS = 270;
export const EVENT_MARK_GROUP = 'study-events';

/** A daily bar's time: local midnight of its date, as the charts stamp daily bars. */
export function eventTime(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(t) ? t : null;
}

/** The window to frame: from well before the event to after it, never past `now`. */
export function eventRange(time: number, now: number): { from: number; to: number } {
  const to = Math.min(now, time + AFTER_DAYS * DAY_MS);
  return { from: time - BEFORE_DAYS * DAY_MS, to: Math.max(to, time + DAY_MS) };
}

/** The mark on the event's bar, or null for a date that isn't one. */
export function eventMark(event: StudyEvent): TimelineMark | null {
  const time = eventTime(event.date);
  if (time === null) return null;
  return {
    id: `study-event-${event.date}`,
    time,
    title: event.label,
    tooltip: `${event.label} · ${event.date}`,
    glyph: { color: '#f59e0b', letter: 'S' },
    group: EVENT_MARK_GROUP,
  };
}

/** Points a chart at the event, framed, and marks it. `chartSymbolOf` turns the long form into the
 *  form a chart is given. Vela treats marks as data to re-supply after a market switch, so the
 *  caller keeps the mark and applies it again (`setEventMark`) when the switch lands. */
export function showStudyEvent(chart: Vela, event: StudyEvent, chartSymbolOf: (s: string) => string, now = Date.now()): TimelineMark | null {
  const mark = eventMark(event);
  if (!mark) return null;
  chart.setMarket({ symbol: chartSymbolOf(event.symbol), timeframe: 'D', visibleRange: eventRange(mark.time, now) });
  setEventMark(chart, mark);
  return mark;
}

/** Shows `mark` as the chart's only Study mark, or clears it with null. */
export function setEventMark(chart: Vela, mark: TimelineMark | null): void {
  chart.marks.defineGroup({ id: EVENT_MARK_GROUP, label: 'Study events' });
  if (mark) chart.marks.set([mark]);
  else chart.marks.clear();
}
