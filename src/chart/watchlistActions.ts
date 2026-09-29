/** **Add SYMBOL to watchlist** in the chart's right-click menu, as in TradingView: hovering it opens every
 *  watchlist with a checkbox, ticked where the list holds the chart's symbol. Ticking adds the symbol,
 *  unticking takes it off, and the menu stays open so several lists can be ticked at once; **New
 *  watchlist…** opens the add-to-watchlist dialog. Quick-access lists come first.
 *
 *  Vela's menu builds its items the moment it opens, so the lists and what they hold are kept here,
 *  read again whenever a watchlist or the quick-access pins change. The submenu itself needs the
 *  `submenu` / `runItem` fields our Vela patch adds to a contributed action
 *  (`patches/@luxalgo+vela+*.patch`); without the patch the item still opens the dialog. */

import { registerIcon, registerWidgetAction, type WidgetActionDescriptor, type WidgetContext } from '@luxalgo/vela/plugin';
import { notify } from '../data/events';
import { addWatchlistItems, errorMessage, listWatchlistMembers, listWatchlists, removeWatchlistItems } from '../lib/ipc';
import { displayTicker, normalizeSymbol } from '../lib/symbols';
import { addToWatchlistLabel, membersByList, NEW_LIST_ITEM, watchlistSubmenu, type MenuItem } from '../lib/watchlistMenu';
import { loadQuickLists, quickLists, subscribeQuickLists } from '../features/watchlist/quickLists';
import { notifyWatchlistsChanged, subscribeWatchlistsChanged } from '../features/watchlist/watchlistBus';
import { openAddToWatchlist } from '../features/watchlist/watchlistUi';

/** A contributed action with what our Vela patch adds: a label built from the chart, and a submenu. */
interface SubmenuAction extends WidgetActionDescriptor {
  labelFor: (ctx: WidgetContext) => string;
  submenu: (ctx: WidgetContext) => MenuItem[];
  runItem: (ctx: WidgetContext, itemId: string) => void;
}

/** A list with a plus, drawn like Vela's own 16px icons. */
const LIST_PLUS_ICON =
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M2.5 4h8M2.5 7.5h8M2.5 11h5"/><path d="M12 9.5v4M10 11.5h4"/></svg>';

let lists: { id: number; name: string }[] = [];
let members = new Map<number, Set<string>>();

async function refresh(): Promise<void> {
  try {
    const [summaries, pairs] = await Promise.all([listWatchlists(), listWatchlistMembers()]);
    lists = summaries.map((l) => ({ id: l.id, name: l.name }));
    members = membersByList(pairs);
  } catch {
    // The menu keeps what it last knew; the next change reads again.
  }
}

async function toggle(listId: number, symbol: string): Promise<void> {
  const list = lists.find((l) => l.id === listId);
  if (!list) return;
  const held = members.get(listId)?.has(symbol) ?? false;
  const shown = displayTicker(symbol);
  try {
    if (held) await removeWatchlistItems(listId, [symbol]);
    else await addWatchlistItems(listId, [{ symbol, name: null }]);
    // At once, so the menu is right if it is opened again before the lists are read again.
    const set = members.get(listId) ?? new Set<string>();
    if (held) set.delete(symbol);
    else set.add(symbol);
    members.set(listId, set);
    notifyWatchlistsChanged();
    notify('info', held ? `Removed ${shown} from “${list.name}”.` : `Added ${shown} to “${list.name}”.`);
  } catch (err) {
    notify('error', `Couldn’t change “${list.name}”: ${errorMessage(err)}`);
  }
}

let installed = false;

/** Registers the action, and keeps what it shows current. Once per window. */
export function installWatchlistActions(): void {
  if (installed) return;
  installed = true;
  registerIcon('list-plus', LIST_PLUS_ICON);
  const action: SubmenuAction = {
    id: 'watchlist.add',
    target: 'context:body',
    label: 'Add to watchlist',
    labelFor: (ctx) => addToWatchlistLabel(displayTicker(normalizeSymbol(ctx.symbol))),
    icon: 'list-plus',
    order: 20,
    // Only reached without the patch (a click on the item itself): the dialog does the same job.
    run: (ctx) => openAddToWatchlist([normalizeSymbol(ctx.symbol)]),
    submenu: (ctx) => watchlistSubmenu(lists, members, quickLists(), normalizeSymbol(ctx.symbol)),
    runItem: (ctx, itemId) => {
      const symbol = normalizeSymbol(ctx.symbol);
      if (itemId === NEW_LIST_ITEM) openAddToWatchlist([symbol], { newList: true });
      else void toggle(Number(itemId), symbol);
    },
  };
  registerWidgetAction(action);
  void loadQuickLists();
  void refresh();
  subscribeQuickLists(() => void refresh());
  subscribeWatchlistsChanged(() => void refresh());
}
