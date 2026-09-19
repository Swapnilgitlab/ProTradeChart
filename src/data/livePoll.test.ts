import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activePollerCount, subscribePolled, type PollOptions } from './livePoll';

const OPTIONS: PollOptions = {
  baseMs: 1_000,
  idleMs: 10_000,
  idlePollsBeforeBackoff: 3,
  maxFailureMs: 30_000,
  isActive: () => true,
};

/** Advances the clock and lets any promises the poll started settle. */
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('subscribePolled', () => {
  const unsubscribers: (() => void)[] = [];
  const subscribe = <T>(key: string, load: () => Promise<T>, onChange: (v: T) => void, options = OPTIONS) => {
    const off = subscribePolled(key, options, load, onChange);
    unsubscribers.push(off);
    return off;
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    unsubscribers.splice(0).forEach((off) => off());
    vi.useRealTimers();
  });

  it('polls on the base interval and reports each change', async () => {
    let n = 0;
    const load = vi.fn(async () => ++n);
    const seen: number[] = [];
    subscribe('a', load, (v) => seen.push(v));

    expect(load).not.toHaveBeenCalled();
    await advance(1_000);
    await advance(1_000);
    expect(seen).toEqual([1, 2]);
  });

  it('stays quiet when nothing changed', async () => {
    const seen: number[] = [];
    subscribe('quiet', async () => 5, (v) => seen.push(v));
    await advance(1_000); // first poll always reports
    await advance(1_000);
    await advance(1_000);
    expect(seen).toEqual([5]);
  });

  it('slows down after several polls with nothing new, and recovers when data moves', async () => {
    let value = 1;
    const load = vi.fn(async () => value);
    subscribe('idle', load, () => {});

    await advance(1_000); // poll 1: new
    await advance(1_000); // poll 2: idle 1
    await advance(1_000); // poll 3: idle 2
    await advance(1_000); // poll 4: idle 3 → backs off from here
    expect(load).toHaveBeenCalledTimes(4);
    await advance(9_000);
    expect(load).toHaveBeenCalledTimes(4);
    await advance(1_000);
    expect(load).toHaveBeenCalledTimes(5);

    value = 2;
    await advance(10_000); // still on the slow cadence, but it notices the change
    expect(load).toHaveBeenCalledTimes(6);
    await advance(1_000); // and is back at the base interval
    expect(load).toHaveBeenCalledTimes(7);
  });

  it('shares one poller — and one request per tick — between subscribers of the same key', async () => {
    const load = vi.fn(async () => 1);
    const first = vi.fn();
    const second = vi.fn();
    subscribe('shared', load, first);
    subscribe('shared', load, second);
    expect(activePollerCount()).toBe(1);

    await advance(1_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('gives a late joiner the current data on the next tick even if it has not changed', async () => {
    const early = vi.fn();
    subscribe('late', async () => 7, early);
    await advance(1_000);
    await advance(1_000);
    expect(early).toHaveBeenCalledTimes(1);

    const late = vi.fn();
    subscribe('late', async () => 7, late);
    await advance(1_000);
    expect(late).toHaveBeenCalledWith(7);
    expect(early).toHaveBeenCalledTimes(1);
  });

  it('keeps polling until the last subscriber leaves, then stops and forgets the key', async () => {
    const load = vi.fn(async () => 1);
    const offA = subscribe('stop', load, () => {});
    const offB = subscribe('stop', load, () => {});
    offA();
    await advance(1_000);
    expect(load).toHaveBeenCalledTimes(1);

    offB();
    expect(activePollerCount()).toBe(0);
    await advance(60_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially while polls fail and resets on success', async () => {
    let fail = true;
    const load = vi.fn(async () => {
      if (fail) throw new Error('rate limited');
      return 1;
    });
    subscribe('fail', load, () => {});

    await advance(1_000); // fails → next in 2s
    expect(load).toHaveBeenCalledTimes(1);
    await advance(1_999);
    expect(load).toHaveBeenCalledTimes(1);
    await advance(1); // fails again → next in 4s
    expect(load).toHaveBeenCalledTimes(2);
    await advance(4_000); // fails → next in 8s
    expect(load).toHaveBeenCalledTimes(3);

    fail = false;
    await advance(8_000); // succeeds
    expect(load).toHaveBeenCalledTimes(4);
    await advance(1_000); // back to the base interval
    expect(load).toHaveBeenCalledTimes(5);
  });

  it('caps the failure delay', async () => {
    const load = vi.fn(async () => {
      throw new Error('down');
    });
    subscribe('cap', load, () => {}, { ...OPTIONS, maxFailureMs: 5_000 });
    // Delays: 1s, 2s, 4s, then 5s, 5s… — ten polls fit well inside a minute.
    await advance(1_000 + 2_000 + 4_000 + 5_000 * 8);
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(11);
  });

  it('does not poll while inactive but keeps its schedule', async () => {
    let active = false;
    const load = vi.fn(async () => 1);
    subscribe('hidden', load, () => {}, { ...OPTIONS, isActive: () => active });
    await advance(5_000);
    expect(load).not.toHaveBeenCalled();
    active = true;
    await advance(1_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('tolerates a subscriber that unsubscribes from inside its callback', async () => {
    const other = vi.fn();
    let off = () => {};
    off = subscribe('reentrant', async () => 1, () => off());
    subscribe('reentrant', async () => 1, other);
    await advance(1_000);
    expect(other).toHaveBeenCalledTimes(1);
  });
});
