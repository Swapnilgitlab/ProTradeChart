import { describe, expect, it, vi } from 'vitest';
import type { PriceAlert } from '../lib/ipc';

// The engine module also wires itself to Tauri and the data layer; the tests
// only exercise the class, so those imports are stubbed out.
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('../data/quotes', () => ({ fetchQuotes: vi.fn() }));
vi.mock('../data/providerStatus', () => ({ ensureProvidersLoaded: vi.fn() }));
vi.mock('../lib/ipc', () => ({ listPriceAlerts: vi.fn(), savePriceAlert: vi.fn() }));
vi.mock('./notifier', () => ({ announceAlert: vi.fn() }));

const { AlertEngine } = await import('./engine');

const alert = (over: Partial<PriceAlert> = {}): PriceAlert => ({
  id: 'a1',
  symbol: 'yahoo:AAPL',
  condition: 'crossing_up',
  price: 100,
  basePrice: 90,
  message: '',
  mode: 'once',
  status: 'active',
  createdAt: 1,
  triggeredAt: null,
  triggerPrice: null,
  triggerCount: 0,
  ...over,
});

/** An engine over an in-memory list of alerts and a scripted price feed. */
function setup(initial: PriceAlert[]) {
  const store = new Map(initial.map((a) => [a.id, a]));
  const prices = new Map<string, number | null>();
  const fired: [PriceAlert, number][] = [];
  const clock = { now: 1_000_000 };
  const save = vi.fn(async (a: PriceAlert) => {
    store.set(a.id, a);
  });
  const priceRequests: string[][] = [];
  const engine = new AlertEngine({
    list: async () => [...store.values()],
    save,
    prices: async (symbols) => {
      priceRequests.push(symbols);
      return new Map(symbols.map((s) => [s, prices.get(s) ?? null]));
    },
    onFire: (a, p) => fired.push([a, p]),
    now: () => clock.now,
  });
  return { engine, store, prices, fired, clock, save, priceRequests };
}

describe('AlertEngine', () => {
  it('fires when the price crosses the level, and records it', async () => {
    const t = setup([alert()]);
    t.prices.set('yahoo:AAPL', 99);
    await t.engine.poll();
    expect(t.fired).toHaveLength(0);

    t.prices.set('yahoo:AAPL', 101);
    await t.engine.poll();
    expect(t.fired).toHaveLength(1);
    expect(t.fired[0][1]).toBe(101);
    expect(t.store.get('a1')).toMatchObject({ status: 'triggered', triggerPrice: 101, triggerCount: 1 });
  });

  it('fires a once-only alert one time, however long the price stays past the level', async () => {
    const t = setup([alert()]);
    t.prices.set('yahoo:AAPL', 99);
    await t.engine.poll();
    for (const p of [101, 105, 110, 90, 101]) {
      t.prices.set('yahoo:AAPL', p);
      await t.engine.poll();
    }
    expect(t.fired).toHaveLength(1);
  });

  it('measures the first sample against the price stored with the alert', async () => {
    // Created at 90; the app was closed while the price ran to 105.
    const t = setup([alert({ basePrice: 90 })]);
    t.prices.set('yahoo:AAPL', 105);
    await t.engine.poll();
    expect(t.fired).toHaveLength(1);
  });

  it('does not fire on the first sample when the alert has no base price, and remembers where it started', async () => {
    const t = setup([alert({ basePrice: null })]);
    t.prices.set('yahoo:AAPL', 105);
    await t.engine.poll();
    expect(t.fired).toHaveLength(0);
    expect(t.store.get('a1')?.basePrice).toBe(105);
  });

  it('does not fire when the price was already past the level from the start', async () => {
    const t = setup([alert({ basePrice: 120 })]);
    t.prices.set('yahoo:AAPL', 125);
    await t.engine.poll();
    expect(t.fired).toHaveLength(0);
  });

  it('leaves paused and already-triggered alerts alone, and does not even ask for their prices', async () => {
    const t = setup([alert({ id: 'p', status: 'paused' }), alert({ id: 't', status: 'triggered' })]);
    t.prices.set('yahoo:AAPL', 105);
    await t.engine.poll();
    expect(t.fired).toHaveLength(0);
    expect(t.priceRequests).toHaveLength(0);
  });

  it('asks for each symbol once, however many alerts watch it', async () => {
    const t = setup([alert({ id: '1' }), alert({ id: '2', price: 110 }), alert({ id: '3', symbol: 'yahoo:MSFT' })]);
    await t.engine.poll();
    expect(t.priceRequests).toEqual([['yahoo:AAPL', 'yahoo:MSFT']]);
  });

  it('skips a symbol that cannot be priced without disturbing the others', async () => {
    const t = setup([alert({ id: 'a', symbol: 'dhan:NSE:X' }), alert({ id: 'b' })]);
    t.prices.set('yahoo:AAPL', 105); // dhan:NSE:X has no price
    await t.engine.poll();
    expect(t.fired.map(([a]) => a.id)).toEqual(['b']);
  });

  it('re-arms an every-time alert and fires it again on the next crossing once the cooldown has passed', async () => {
    const t = setup([alert({ mode: 'every', condition: 'crossing' })]);
    t.prices.set('yahoo:AAPL', 99);
    await t.engine.poll();
    t.prices.set('yahoo:AAPL', 101);
    await t.engine.poll();
    expect(t.fired).toHaveLength(1);
    expect(t.store.get('a1')?.status).toBe('active');

    // Back below the level straight away: inside the cooldown, so no second ring.
    t.clock.now += 5_000;
    t.prices.set('yahoo:AAPL', 99);
    await t.engine.poll();
    expect(t.fired).toHaveLength(1);

    // Above again after the cooldown: fires.
    t.clock.now += 120_000;
    t.prices.set('yahoo:AAPL', 101);
    await t.engine.poll();
    expect(t.fired).toHaveLength(2);
    expect(t.store.get('a1')?.triggerCount).toBe(2);
  });

  it('does not announce an alert it failed to save, and tries the same crossing again', async () => {
    const t = setup([alert()]);
    t.prices.set('yahoo:AAPL', 99);
    await t.engine.poll();

    t.save.mockRejectedValueOnce(new Error('database is locked'));
    t.prices.set('yahoo:AAPL', 101);
    await t.engine.poll();
    expect(t.fired).toHaveLength(0);
    expect(t.store.get('a1')?.status).toBe('active');

    await t.engine.poll(); // the database is back
    expect(t.fired).toHaveLength(1);
    expect(t.store.get('a1')?.status).toBe('triggered');
  });

  it('survives a failing price source and carries on at the next poll', async () => {
    const log = vi.fn();
    const store = [alert()];
    let fail = true;
    const fired: number[] = [];
    const engine = new AlertEngine({
      list: async () => store,
      save: async () => {},
      prices: async (symbols) => {
        if (fail) throw new Error('offline');
        return new Map(symbols.map((s) => [s, 105]));
      },
      onFire: (_a, p) => fired.push(p),
      now: () => 1,
      log,
    });
    await engine.poll();
    expect(log).toHaveBeenCalled();
    fail = false;
    await engine.poll();
    expect(fired).toEqual([105]);
  });

  it('ignores a poll that starts while another is still running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const engine = new AlertEngine({
      list: async () => {
        calls += 1;
        await gate;
        return [];
      },
      save: async () => {},
      prices: async () => new Map(),
      onFire: () => {},
      now: () => 1,
    });
    const first = engine.poll();
    const second = engine.poll();
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  it('forgets the last price of an alert that is deleted or paused', async () => {
    const t = setup([alert()]);
    t.prices.set('yahoo:AAPL', 99);
    await t.engine.poll(); // remembers 99
    t.store.set('a1', alert({ status: 'paused' }));
    await t.engine.poll();
    // Resumed after the price moved on: measured from the stored base again, not from the stale 99.
    t.store.set('a1', alert({ basePrice: 120 }));
    t.prices.set('yahoo:AAPL', 125);
    await t.engine.poll();
    expect(t.fired).toHaveLength(0);
  });
});
