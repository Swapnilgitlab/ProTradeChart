import { describe, expect, it } from 'vitest';
import { eventRange, eventTime } from './studyEvent';

describe('study events on a chart', () => {
  it('stamp the event on local midnight of its date, like a daily bar', () => {
    const t = eventTime('2024-03-15')!;
    const d = new Date(t);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2024, 2, 15, 0]);
    expect(eventTime('15/03/2024')).toBeNull();
  });

  it('frame a year before the event and months after, never the future', () => {
    const t = eventTime('2020-06-01')!;
    const { from, to } = eventRange(t, Date.UTC(2030, 0, 1));
    expect((t - from) / 86_400_000).toBe(380);
    expect((to - t) / 86_400_000).toBe(270);
    const recent = eventRange(t, t + 5 * 86_400_000);
    expect(recent.to).toBe(t + 5 * 86_400_000);
  });
});
