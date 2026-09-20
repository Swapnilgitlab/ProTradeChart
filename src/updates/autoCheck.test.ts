import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECHECK_MS, STARTUP_DELAY_MS, startAutoUpdates } from './autoCheck';
import { Updater, type UpdateOffer } from './updater';

const offer = (version: string): UpdateOffer => ({ version, date: null, downloadAndInstall: async () => {} });

function start(result: () => Promise<UpdateOffer | null>) {
  const check = vi.fn(result);
  const updater = new Updater({ check, restart: async () => {} });
  const announce = vi.fn();
  const preference = { value: null as string | null, fail: false };
  const stop = startAutoUpdates({
    updater,
    announce,
    readPreference: async () => {
      if (preference.fail) throw new Error('unreadable');
      return preference.value;
    },
  });
  return { updater, check, announce, preference, stop };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startAutoUpdates', () => {
  it('waits before the first check', async () => {
    const h = start(async () => offer('0.2.0'));
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS - 1);
    expect(h.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.check).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it('announces a waiting update once, however many times it looks', async () => {
    const h = start(async () => offer('0.2.0'));
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(h.announce).toHaveBeenCalledTimes(1);
    expect(h.announce).toHaveBeenCalledWith('0.2.0');
    h.stop();
  });

  it('says nothing when the app is already current', async () => {
    const h = start(async () => null);
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.announce).not.toHaveBeenCalled();
    h.stop();
  });

  it('does not check when the user switched it off, and notices the switch without a restart', async () => {
    const h = start(async () => null);
    h.preference.value = 'off';
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(h.check).not.toHaveBeenCalled();

    h.preference.value = 'on';
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(h.check).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it('checks when the preference cannot be read', async () => {
    const h = start(async () => null);
    h.preference.fail = true;
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(h.check).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it('stays quiet when the check fails (offline, or no release yet)', async () => {
    const h = start(async () => {
      throw new Error('error sending request');
    });
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(h.announce).not.toHaveBeenCalled();
    expect(h.updater.getState()).toEqual({ kind: 'idle' });
    h.stop();
  });

  it('stops when told to', async () => {
    const h = start(async () => null);
    h.stop();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + RECHECK_MS);
    expect(h.check).not.toHaveBeenCalled();
  });
});
