/** Scheduled sequences of scripts, as the Scheduler tab shows and edits them. The rules themselves are
 *  the backend's (`scheduler/plan.rs`, `store/schedules.rs`); `ruleProblem` and `scheduleProblem`
 *  repeat its checks so the form can say what's wrong before saving. Times are IST, like the
 *  schedules. Pure. */

import type { ScheduleRule, ScheduleRunStatus } from '../lib/ipc';

export const MIN_EVERY_MINUTES = 5;
/** The most scripts one schedule runs (`store::schedules::MAX_SCRIPTS`). */
export const MAX_SCRIPTS = 20;
export const MAX_EVERY_MINUTES = 720;
/** Monday first, as the backend counts. */
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const WEEKDAYS = [true, true, true, true, true, false, false];
export const EVERY_DAY = [true, true, true, true, true, true, true];

/** A new schedule: weekdays at 16:00, after the day's closing prices have settled. */
export const defaultRule = (): ScheduleRule => ({ days: [...WEEKDAYS], kind: 'daily', at: 16 * 60 });

/** Minutes since midnight as `HH:MM`. */
export function minutesToText(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** `HH:MM` (as a time input gives it) as minutes since midnight, or null. */
export function textToMinutes(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  return h < 24 && min < 60 ? h * 60 + min : null;
}

const same = (a: readonly boolean[], b: readonly boolean[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export function describeDays(days: readonly boolean[]): string {
  if (same(days, EVERY_DAY)) return 'Every day';
  if (same(days, WEEKDAYS)) return 'Weekdays';
  if (same(days, [false, false, false, false, false, true, true])) return 'Weekends';
  return DAY_NAMES.filter((_, i) => days[i]).join(', ') || 'No days';
}

/** "Weekdays at 16:00 IST", "Weekdays, every 15 min from 09:15 to 15:30 IST". */
export function describeRule(rule: ScheduleRule): string {
  const days = describeDays(rule.days);
  if (rule.kind === 'daily') return `${days} at ${minutesToText(rule.at)} IST`;
  return `${days}, every ${rule.minutes} min from ${minutesToText(rule.from)} to ${minutesToText(rule.until)} IST`;
}

/** The problem with a rule, or null. The backend's `Rule::check`, in the same words. */
export function ruleProblem(rule: ScheduleRule): string | null {
  if (rule.days.length !== 7 || !rule.days.some(Boolean)) return 'Choose at least one day.';
  const inDay = (m: number) => Number.isInteger(m) && m >= 0 && m < 24 * 60;
  if (rule.kind === 'daily') return inDay(rule.at) ? null : 'The time must be within the day (00:00 to 23:59).';
  if (!Number.isInteger(rule.minutes) || rule.minutes < MIN_EVERY_MINUTES || rule.minutes > MAX_EVERY_MINUTES) {
    return `Run every ${MIN_EVERY_MINUTES} to ${MAX_EVERY_MINUTES} minutes.`;
  }
  if (!inDay(rule.from) || !inDay(rule.until)) return 'The times must be within the day (00:00 to 23:59).';
  if (rule.until < rule.from) return 'The last run can’t come before the first.';
  return null;
}

const IST = 'Asia/Kolkata';
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' });
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false });
const dated = new Intl.DateTimeFormat('en-GB', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short' });

/** A moment as people say it, on the IST clock: "today 16:00", "tomorrow 09:15", "Mon 12 Jan 16:00". */
export function whenText(ms: number, now: number): string {
  const day = dayKey.format(ms);
  const time = clock.format(ms);
  if (day === dayKey.format(now)) return `today ${time}`;
  if (day === dayKey.format(now + 86_400_000)) return `tomorrow ${time}`;
  if (day === dayKey.format(now - 86_400_000)) return `yesterday ${time}`;
  return `${dated.format(ms)} ${time}`;
}

export const STATUS_LABEL: Record<ScheduleRunStatus, string> = {
  running: 'Running',
  ok: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
  missed: 'Missed',
  skipped: 'Skipped',
  'not-run': 'Not run',
};

/** The sequence with the script at `index` moved `delta` places (clamped to the ends). */
export function moveScript(scripts: readonly string[], index: number, delta: number): string[] {
  const next = [...scripts];
  const to = Math.min(Math.max(index + delta, 0), next.length - 1);
  if (index < 0 || index >= next.length || to === index) return next;
  const [moved] = next.splice(index, 1);
  next.splice(to, 0, moved);
  return next;
}

/** The sequence without the script at `index`. */
export const removeScript = (scripts: readonly string[], index: number): string[] => scripts.filter((_, i) => i !== index);

/** The problem with a schedule before it is saved, or null: a name, one to `MAX_SCRIPTS` scripts that
 *  all exist, and a rule that fires. The backend's checks, in the same words. */
export function scheduleProblem(name: string, scripts: readonly string[], available: readonly string[], rule: ScheduleRule): string | null {
  const trimmed = name.trim();
  if (!trimmed || [...trimmed].length > 100) return 'A schedule needs a name of 1 to 100 characters.';
  if (scripts.length === 0) return 'Add at least one script to run.';
  if (scripts.length > MAX_SCRIPTS) return `A schedule can run at most ${MAX_SCRIPTS} scripts.`;
  const missing = scripts.find((s) => !available.includes(s));
  if (missing) return `There is no script called ${missing}.`;
  return ruleProblem(rule);
}
