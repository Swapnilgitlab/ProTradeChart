import type { Vela } from '@luxalgo/vela';
import { registerWidgetAction } from '@luxalgo/vela/plugin';
import { localDayKey, localMidnight } from '../lib/timeframes';

/** Bar replay: rewind a chart to a past bar and reveal the bars after it one at a time, by hand
 *  or on a timer (`VelaWorkspace.replay`, which keeps every chart of a grid on one clock). Vela
 *  draws the replay itself (the hidden bars, a "Replay" watermark, a status-line badge) but has no
 *  control to start one, so the app adds two: **Replay** on the chart's toolbar, which opens the
 *  control strip to pick a date, and **Replay from this bar** in the right-click menu. Replay
 *  works on the bars already loaded (an earlier start loads older ones first), never on ticks:
 *  a tick replay would read one-minute history for every bar, at the broker's pace. */

/** How many times faster than one bar a second. */
export const SPEEDS = [1, 2, 5, 10] as const;
export type Speed = (typeof SPEEDS)[number];

/** The pause between two revealed bars at `speed`, in ms. */
export function intervalFor(speed: Speed): number {
  return 1000 / speed;
}

/** Where a replay picked by date starts: the chart keeps every bar opened by that day's local
 *  midnight, which is how a daily bar is stamped, so a daily chart shows that day's bar and an
 *  intraday one stops at the day before's close. Null for a value that isn't a date. Pure. */
export function replayStartOf(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ms = localMidnight(date);
  return Number.isFinite(ms) ? ms : null;
}

/** A date input's value for an instant (`YYYY-MM-DD`, local). Pure. */
export function dateInputValue(ms: number): string {
  return localDayKey(ms);
}

export interface ReplayRequest {
  /** The chart (a workspace cell's) the request came from. */
  chart: Vela;
  /** Start at this bar's open time; null to open the controls and pick a date. */
  from: number | null;
}

type Listener = (request: ReplayRequest) => void;
const listeners = new Set<Listener>();

/** Asks the tab that owns `request.chart` to open its replay controls. */
export function requestReplay(request: ReplayRequest): void {
  listeners.forEach((listener) => listener(request));
}

export function onReplayRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let installed = false;

/** Registers the two actions. Once is enough: Vela reads them for every chart, present and future. */
export function installReplayActions(): void {
  if (installed) return;
  installed = true;
  registerWidgetAction({
    id: 'chart.replay',
    target: 'topbar',
    label: 'Replay',
    icon: 'replay',
    align: 'left',
    order: 20,
    run: (ctx) => requestReplay({ chart: ctx.chart, from: null }),
  });
  registerWidgetAction({
    id: 'chart.replay-here',
    target: 'context:body',
    label: 'Replay from this bar',
    icon: 'replay',
    order: 30,
    when: (ctx) => typeof ctx.pointer?.time === 'number',
    run: (ctx) => {
      if (typeof ctx.pointer?.time === 'number') requestReplay({ chart: ctx.chart, from: ctx.pointer.time });
    },
  });
}
