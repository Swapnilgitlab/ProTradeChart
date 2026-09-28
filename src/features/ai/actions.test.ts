import { describe, expect, it, vi } from 'vitest';
import type { ProposedAction } from '../../lib/ipc';

const addWatchlistItems = vi.fn(async () => ({}));
const removeWatchlistItems = vi.fn(async () => {});
const createWatchlist = vi.fn(async () => ({}));
const savePriceAlert = vi.fn(async () => {});
let watchlists: { id: number; name: string }[] = [{ id: 1, name: 'Getting started' }];
const listWatchlists = vi.fn(async () => watchlists);

vi.mock('../../lib/ipc', () => ({ addWatchlistItems, removeWatchlistItems, createWatchlist, savePriceAlert, listWatchlists }));

const { prepareAction } = await import('./actions');

const ctx = {
  onOpenSymbol: vi.fn(),
  onSetTimeframe: vi.fn(),
  onAddIndicator: vi.fn(async () => ({ ok: true, message: 'Added RSI.' })),
  onRemoveIndicator: vi.fn(async () => ({ ok: true, message: 'Removed RSI.' })),
};

const action = (tool: string, args: Record<string, unknown>): ProposedAction => ({ tool, arguments: args });

describe('what a proposed action is refused for', () => {
  it('an unknown tool', () => {
    expect(prepareAction(action('delete_everything', {}), ctx)).toBeNull();
  });

  it('a required argument missing or the wrong type', () => {
    expect(prepareAction(action('add_watchlist_item', { watchlist: 'Getting started' }), ctx)).toBeNull();
    expect(prepareAction(action('add_watchlist_item', { watchlist: 'Getting started', symbol: '' }), ctx)).toBeNull();
    expect(prepareAction(action('create_watchlist', { name: 42 }), ctx)).toBeNull();
    expect(prepareAction(action('set_timeframe', {}), ctx)).toBeNull();
  });

  it('a price alert with a bad condition or a non-positive price', () => {
    expect(prepareAction(action('create_price_alert', { symbol: 'BTCUSDT', condition: 'sideways', price: 100, message: '' }), ctx)).toBeNull();
    expect(prepareAction(action('create_price_alert', { symbol: 'BTCUSDT', condition: 'crossing_up', price: 0, message: '' }), ctx)).toBeNull();
    expect(prepareAction(action('create_price_alert', { symbol: 'BTCUSDT', condition: 'crossing_up', price: -5, message: '' }), ctx)).toBeNull();
  });
});

describe('a symbol argument', () => {
  it('is resolved the same way the symbol search box would', () => {
    expect(prepareAction(action('open_symbol', { symbol: 'BTCUSDT' }), ctx)?.summary).toBe('Open binance:BTCUSDT on the chart');
    expect(prepareAction(action('open_symbol', { symbol: 'zerodha:hfcl' }), ctx)?.summary).toBe('Open zerodha:NSE:HFCL on the chart');
  });
});

describe('watchlist actions', () => {
  it('add a symbol once approved, and fail plainly for an unknown watchlist', async () => {
    const prepared = prepareAction(action('add_watchlist_item', { watchlist: 'Getting started', symbol: 'ETHUSDT' }), ctx);
    expect(prepared?.summary).toBe('Add binance:ETHUSDT to “Getting started”');
    const result = await prepared!.run();
    expect(result).toEqual({ ok: true, message: 'Added binance:ETHUSDT to Getting started.' });
    expect(addWatchlistItems).toHaveBeenCalledWith(1, [{ symbol: 'binance:ETHUSDT' }]);

    const missing = prepareAction(action('remove_watchlist_item', { watchlist: 'No such list', symbol: 'ETHUSDT' }), ctx);
    expect(await missing!.run()).toEqual({ ok: false, message: 'No watchlist named "No such list".' });
  });

  it('creates one by name', async () => {
    const prepared = prepareAction(action('create_watchlist', { name: 'Swing setups' }), ctx);
    expect(prepared?.summary).toBe('Create a new watchlist “Swing setups”');
    expect(await prepared!.run()).toEqual({ ok: true, message: 'Created “Swing setups”.' });
    expect(createWatchlist).toHaveBeenCalledWith('Swing setups');
  });
});

describe('chart actions', () => {
  it('open a symbol and change the timeframe through the given callbacks', async () => {
    const openSymbol = prepareAction(action('open_symbol', { symbol: 'binance:SOLUSDT' }), ctx)!;
    expect(await openSymbol.run()).toEqual({ ok: true, message: 'Opened binance:SOLUSDT.' });
    expect(ctx.onOpenSymbol).toHaveBeenCalledWith('binance:SOLUSDT');

    const setTf = prepareAction(action('set_timeframe', { timeframe: '60' }), ctx)!;
    expect(await setTf.run()).toEqual({ ok: true, message: 'Timeframe set to 60.' });
    expect(ctx.onSetTimeframe).toHaveBeenCalledWith('60');
  });

  it('add and remove an indicator through the given callbacks, reporting what they say', async () => {
    const add = prepareAction(action('add_indicator', { indicator: 'RSI' }), ctx)!;
    expect(add.summary).toBe('Add the RSI indicator');
    expect(await add.run()).toEqual({ ok: true, message: 'Added RSI.' });
    expect(ctx.onAddIndicator).toHaveBeenCalledWith('RSI');

    const remove = prepareAction(action('remove_indicator', { indicator: 'RSI' }), ctx)!;
    expect(await remove.run()).toEqual({ ok: true, message: 'Removed RSI.' });
  });
});

describe('a price alert', () => {
  it('is created with no base price, so it judges only crossings from here on', async () => {
    const prepared = prepareAction(action('create_price_alert', { symbol: 'BTCUSDT', condition: 'crossing_up', price: 95000, message: 'Breakout' }), ctx)!;
    expect(prepared.summary).toBe('Alert when binance:BTCUSDT crosses above 95000');
    expect(await prepared.run()).toEqual({ ok: true, message: 'Alert created on binance:BTCUSDT.' });
    expect(savePriceAlert).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'binance:BTCUSDT', condition: 'crossing_up', price: 95000, basePrice: null, message: 'Breakout', status: 'active' }),
    );
  });

  it('reads "crosses below" for crossing_down', () => {
    const prepared = prepareAction(action('create_price_alert', { symbol: 'BTCUSDT', condition: 'crossing_down', price: 50000, message: '' }), ctx)!;
    expect(prepared.summary).toBe('Alert when binance:BTCUSDT crosses below 50000');
  });
});
