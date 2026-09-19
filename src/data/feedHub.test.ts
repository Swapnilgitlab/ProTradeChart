import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedStatus } from '../lib/ipc';

type Handler = (event: { payload: unknown }) => void;
const handlers = new Map<string, Handler[]>();

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: Handler) => {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    return () => {};
  }),
}));

const noticed: string[] = [];
vi.mock('./events', () => ({ notify: (_level: string, message: string) => noticed.push(message) }));

const { createFeedHub } = await import('./feedHub');

interface Tick {
  token: number;
  ltp: number;
}

/** Delivers a Tauri event to whoever listened for it. */
const emit = (event: string, payload: unknown) => handlers.get(event)?.forEach((h) => h({ payload }));
/** Lets the hub's async start-up (registering its listeners) finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function makeHub(status: FeedStatus = { state: 'live', message: null }) {
  return createFeedHub<Tick>({
    tickEvent: 'x-tick',
    statusEvent: 'x-status',
    keyOf: (t) => String(t.token),
    loadStatus: async () => status,
  });
}

describe('createFeedHub', () => {
  beforeEach(() => {
    handlers.clear();
    noticed.length = 0;
  });

  it('delivers a tick only to the subscribers of that instrument', async () => {
    const hub = makeHub();
    const a = vi.fn();
    const b = vi.fn();
    hub.onTick('1', a);
    hub.onTick('2', b);
    await settle();

    emit('x-tick', { token: 1, ltp: 100 });
    expect(a).toHaveBeenCalledWith({ token: 1, ltp: 100 });
    expect(b).not.toHaveBeenCalled();
  });

  it('gives every chart watching the same instrument its own copy of the tick', async () => {
    const hub = makeHub();
    const first = vi.fn();
    const second = vi.fn();
    hub.onTick('7', first);
    hub.onTick('7', second);
    await settle();

    emit('x-tick', { token: 7, ltp: 5 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops delivering once a subscriber unsubscribes, and keeps the others', async () => {
    const hub = makeHub();
    const staying = vi.fn();
    const leaving = vi.fn();
    hub.onTick('7', staying);
    const off = hub.onTick('7', leaving);
    await settle();

    off();
    emit('x-tick', { token: 7, ltp: 5 });
    expect(leaving).not.toHaveBeenCalled();
    expect(staying).toHaveBeenCalledTimes(1);
  });

  it('listens to the backend only once however many charts subscribe', async () => {
    const hub = makeHub();
    hub.onTick('1', () => {});
    hub.onTick('2', () => {});
    hub.onStatus(() => {});
    await settle();
    expect(handlers.get('x-tick')).toHaveLength(1);
    expect(handlers.get('x-status')).toHaveLength(1);
  });

  it('tells a status subscriber the current state at once, then each change', async () => {
    const hub = makeHub({ state: 'live', message: null });
    const seen: FeedStatus[] = [];
    hub.onStatus((s) => seen.push(s));
    expect(seen).toEqual([{ state: 'idle', message: null }]);

    await settle();
    emit('x-status', { state: 'reconnecting', message: 'link dropped' });
    expect(seen[seen.length - 1]).toEqual({ state: 'reconnecting', message: 'link dropped' });
  });

  it('remembers the last status for a subscriber that arrives later', async () => {
    const hub = makeHub();
    hub.onStatus(() => {});
    await settle();
    emit('x-status', { state: 'live', message: null });

    const late = vi.fn();
    hub.onStatus(late);
    expect(late).toHaveBeenCalledWith({ state: 'live', message: null });
  });

  it('turns a failure the user must act on into a notice, and only failures', async () => {
    const hub = makeHub();
    hub.onStatus(() => {});
    await settle();

    emit('x-status', { state: 'error', message: 'Your token expired' });
    emit('x-status', { state: 'reconnecting', message: 'link dropped' });
    emit('x-status', { state: 'error', message: null });
    expect(noticed).toEqual(['Your token expired']);
  });

  it('keeps two hubs apart', async () => {
    const one = makeHub();
    const two = createFeedHub<Tick>({
      tickEvent: 'y-tick',
      statusEvent: 'y-status',
      keyOf: (t) => String(t.token),
      loadStatus: async () => ({ state: 'idle', message: null }),
    });
    const a = vi.fn();
    const b = vi.fn();
    one.onTick('1', a);
    two.onTick('1', b);
    await settle();

    emit('y-tick', { token: 1, ltp: 1 });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
