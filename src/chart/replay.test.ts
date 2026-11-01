import { describe, expect, it, vi } from 'vitest';
import type { Vela } from '@luxalgo/vela';

vi.mock('@luxalgo/vela/plugin', () => ({ registerWidgetAction: () => () => {} }));

const { dateInputValue, intervalFor, onReplayRequest, replayStartOf, requestReplay, SPEEDS } = await import('./replay');

describe('bar replay', () => {
  it('starts a picked date at its local midnight, where its daily bar is stamped', () => {
    expect(replayStartOf('2024-03-05')).toBe(new Date(2024, 2, 5).getTime());
    expect(replayStartOf('')).toBeNull();
    expect(replayStartOf('5 March')).toBeNull();
    expect(dateInputValue(new Date(2024, 2, 5, 14, 30).getTime())).toBe('2024-03-05');
  });

  it('plays one bar a second at 1×, faster at each speed', () => {
    expect(SPEEDS.map(intervalFor)).toEqual([1000, 500, 200, 100]);
  });

  it('hands a request to every listener until it stops listening', () => {
    const seen: (number | null)[] = [];
    const stop = onReplayRequest((r) => seen.push(r.from));
    const chart = {} as Vela;
    requestReplay({ chart, from: 1000 });
    stop();
    requestReplay({ chart, from: null });
    expect(seen).toEqual([1000]);
  });
});
