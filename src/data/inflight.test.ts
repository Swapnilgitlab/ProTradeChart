import { describe, expect, it, vi } from 'vitest';
import { coalesce } from './inflight';

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('coalesce', () => {
  it('runs simultaneous identical requests once and gives every caller the result', async () => {
    const inflight = new Map<string, Promise<number>>();
    const gate = deferred<number>();
    const run = vi.fn(() => gate.promise);

    const calls = [coalesce(inflight, 'AAPL|D', run), coalesce(inflight, 'AAPL|D', run), coalesce(inflight, 'AAPL|D', run)];
    gate.resolve(42);

    expect(await Promise.all(calls)).toEqual([42, 42, 42]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps different keys apart', async () => {
    const inflight = new Map<string, Promise<string>>();
    const run = vi.fn(async () => 'x');
    await Promise.all([coalesce(inflight, 'AAPL|D', run), coalesce(inflight, 'AAPL|60', run), coalesce(inflight, 'MSFT|D', run)]);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('is not a cache: a request made after the first has finished runs again', async () => {
    const inflight = new Map<string, Promise<number>>();
    let n = 0;
    const run = vi.fn(async () => ++n);
    expect(await coalesce(inflight, 'k', run)).toBe(1);
    expect(await coalesce(inflight, 'k', run)).toBe(2);
    expect(inflight.size).toBe(0);
  });

  it('shares a failure with everyone waiting, then lets the next call try afresh', async () => {
    const inflight = new Map<string, Promise<number>>();
    const gate = deferred<number>();
    const run = vi.fn().mockImplementationOnce(() => gate.promise).mockImplementationOnce(async () => 7);

    const first = coalesce(inflight, 'k', run);
    const second = coalesce(inflight, 'k', run);
    gate.reject(new Error('rate limited'));

    await expect(first).rejects.toThrow('rate limited');
    await expect(second).rejects.toThrow('rate limited');
    expect(run).toHaveBeenCalledTimes(1);
    expect(await coalesce(inflight, 'k', run)).toBe(7);
  });
});
