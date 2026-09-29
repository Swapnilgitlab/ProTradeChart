import { describe, expect, it } from 'vitest';
import type { ScheduleRule } from '../lib/ipc';
import { defaultRule, describeDays, describeRule, minutesToText, ruleProblem, textToMinutes, whenText, WEEKDAYS } from './schedules';

/** Monday 5 January 2026, 00:00 IST (the backend's tests use the same Monday). */
const MON = 1_767_551_400_000;
const at = (day: number, hour: number, minute = 0) => MON + day * 86_400_000 + hour * 3_600_000 + minute * 60_000;

const every = (patch: Partial<Extract<ScheduleRule, { kind: 'every' }>> = {}): ScheduleRule => ({
  days: [...WEEKDAYS],
  kind: 'every',
  minutes: 15,
  from: 9 * 60 + 15,
  until: 15 * 60 + 30,
  ...patch,
});

describe('schedule rules as the Python tab shows them', () => {
  it('reads and writes times of day', () => {
    expect(minutesToText(9 * 60 + 5)).toBe('09:05');
    expect(textToMinutes('16:00')).toBe(960);
    expect(textToMinutes('9:15')).toBe(555);
    for (const bad of ['24:00', '12:60', 'noon', '']) expect(textToMinutes(bad)).toBeNull();
  });

  it('names the days the usual way', () => {
    expect(describeDays(WEEKDAYS)).toBe('Weekdays');
    expect(describeDays([true, true, true, true, true, true, true])).toBe('Every day');
    expect(describeDays([false, false, false, false, false, true, true])).toBe('Weekends');
    expect(describeDays([true, false, true, false, true, false, false])).toBe('Mon, Wed, Fri');
  });

  it('describes a rule in a sentence', () => {
    expect(describeRule(defaultRule())).toBe('Weekdays at 16:00 IST');
    expect(describeRule(every())).toBe('Weekdays, every 15 min from 09:15 to 15:30 IST');
  });

  it('refuses what the backend would', () => {
    expect(ruleProblem(defaultRule())).toBeNull();
    expect(ruleProblem(every())).toBeNull();
    expect(ruleProblem({ ...defaultRule(), days: Array(7).fill(false) })).toContain('at least one day');
    expect(ruleProblem({ ...defaultRule(), kind: 'daily', at: 1440 })).toContain('within the day');
    expect(ruleProblem(every({ minutes: 4 }))).toContain('5 to 720');
    expect(ruleProblem(every({ minutes: 721 }))).toContain('5 to 720');
    expect(ruleProblem(every({ from: 600, until: 540 }))).toContain('can’t come before');
  });

  it('says when, on the IST clock', () => {
    expect(whenText(at(0, 16), at(0, 10))).toBe('today 16:00');
    expect(whenText(at(1, 9, 15), at(0, 23))).toBe('tomorrow 09:15');
    expect(whenText(at(0, 16), at(1, 8))).toBe('yesterday 16:00');
    expect(whenText(at(7, 16), at(0, 10))).toBe('Mon 12 Jan 16:00');
  });
});
