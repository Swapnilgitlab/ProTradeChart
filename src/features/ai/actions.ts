//! Turns one action Ask AI proposed into something the app can actually run — or refuses it. This
//! is the one place a proposed action becomes a real call: every mutating function it reaches
//! (`addWatchlistItems`, `savePriceAlert`, a chart's own indicator/timeframe methods) is the exact
//! same one the matching UI already uses, and nothing here runs until the user approves the card
//! built from `summary`. See "Ask AI" in `docs/ARCHITECTURE.md`.

import type { ActionResult } from '../../chart/ChartView';
import { addWatchlistItems, createWatchlist, listWatchlists, removeWatchlistItems, savePriceAlert, type ProposedAction } from '../../lib/ipc';
import { resolveTypedSymbol } from '../../lib/symbols';

export interface ActionContext {
  onOpenSymbol: (symbol: string) => void;
  onSetTimeframe: (timeframe: string) => void;
  onAddIndicator: (name: string) => Promise<ActionResult>;
  onRemoveIndicator: (name: string) => Promise<ActionResult>;
}

export interface PreparedAction {
  /** The confirmation card's text — plain words, never HTML or markup. */
  summary: string;
  run: () => Promise<ActionResult>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const symbolArg = (v: unknown): string | null => {
  const s = str(v);
  return s ? resolveTypedSymbol(s) : null;
};

async function watchlistId(name: string): Promise<number | null> {
  const rows = await listWatchlists();
  return rows.find((w) => w.name.toLowerCase() === name.toLowerCase())?.id ?? null;
}

const noSuchWatchlist = (name: string): ActionResult => ({ ok: false, message: `No watchlist named "${name}".` });

/** Turns one proposed tool call into a confirmable action, or `null` when its name or arguments
 *  don't match the allowlist — dropped silently rather than shown as a broken card. Belt-and-
 *  braces on top of the schema the AI was given: nothing here trusts that it was followed. */
export function prepareAction(action: ProposedAction, ctx: ActionContext): PreparedAction | null {
  const args = action.arguments ?? {};
  switch (action.tool) {
    case 'add_watchlist_item': {
      const watchlist = str(args.watchlist);
      const symbol = symbolArg(args.symbol);
      if (!watchlist || !symbol) return null;
      return {
        summary: `Add ${symbol} to “${watchlist}”`,
        run: async () => {
          const id = await watchlistId(watchlist);
          if (id == null) return noSuchWatchlist(watchlist);
          await addWatchlistItems(id, [{ symbol }]);
          return { ok: true, message: `Added ${symbol} to ${watchlist}.` };
        },
      };
    }
    case 'remove_watchlist_item': {
      const watchlist = str(args.watchlist);
      const symbol = symbolArg(args.symbol);
      if (!watchlist || !symbol) return null;
      return {
        summary: `Remove ${symbol} from “${watchlist}”`,
        run: async () => {
          const id = await watchlistId(watchlist);
          if (id == null) return noSuchWatchlist(watchlist);
          await removeWatchlistItems(id, [symbol]);
          return { ok: true, message: `Removed ${symbol} from ${watchlist}.` };
        },
      };
    }
    case 'create_watchlist': {
      const name = str(args.name);
      if (!name) return null;
      return {
        summary: `Create a new watchlist “${name}”`,
        run: async () => {
          await createWatchlist(name);
          return { ok: true, message: `Created “${name}”.` };
        },
      };
    }
    case 'open_symbol': {
      const symbol = symbolArg(args.symbol);
      if (!symbol) return null;
      return {
        summary: `Open ${symbol} on the chart`,
        run: () => {
          ctx.onOpenSymbol(symbol);
          return Promise.resolve({ ok: true, message: `Opened ${symbol}.` });
        },
      };
    }
    case 'set_timeframe': {
      const timeframe = str(args.timeframe);
      if (!timeframe) return null;
      return {
        summary: `Change the chart to the ${timeframe} timeframe`,
        run: () => {
          ctx.onSetTimeframe(timeframe);
          return Promise.resolve({ ok: true, message: `Timeframe set to ${timeframe}.` });
        },
      };
    }
    case 'add_indicator': {
      const name = str(args.indicator);
      if (!name) return null;
      return { summary: `Add the ${name} indicator`, run: () => ctx.onAddIndicator(name) };
    }
    case 'remove_indicator': {
      const name = str(args.indicator);
      if (!name) return null;
      return { summary: `Remove the ${name} indicator`, run: () => ctx.onRemoveIndicator(name) };
    }
    case 'create_price_alert': {
      const symbol = symbolArg(args.symbol);
      const condition = args.condition === 'crossing_up' || args.condition === 'crossing_down' ? args.condition : null;
      const price = num(args.price);
      const message = typeof args.message === 'string' ? args.message : '';
      if (!symbol || !condition || price == null || price <= 0) return null;
      return {
        summary: `Alert when ${symbol} crosses ${condition === 'crossing_up' ? 'above' : 'below'} ${price}`,
        run: async () => {
          await savePriceAlert({
            id: crypto.randomUUID(),
            symbol,
            condition,
            price,
            basePrice: null,
            message,
            mode: 'once',
            status: 'active',
            createdAt: Date.now(),
            triggeredAt: null,
            triggerPrice: null,
            triggerCount: 0,
          });
          return { ok: true, message: `Alert created on ${symbol}.` };
        },
      };
    }
    default:
      return null;
  }
}
