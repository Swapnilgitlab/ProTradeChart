/** The chart's right-click **Add SYMBOL to watchlist** submenu, as TradingView has it: every watchlist
 *  with a checkbox, ticked on those that already hold the chart's symbol — ticking one adds the
 *  symbol, unticking takes it off, and the menu stays open for the next — then **New watchlist…**.
 *  Quick-access lists come first, in pin order; the rest follow by name. Pure. */

/** The item's label: the symbol as the app shows it, e.g. "Add DIACABS to watchlist". */
export const addToWatchlistLabel = (ticker: string) => `Add ${ticker} to watchlist`;

export interface MenuItem {
  id: string;
  label: string;
  checked?: boolean;
  /** Drawn as a checkbox, and picking it leaves the menu open (our Vela patch), so several lists can be
   *  ticked in one go. */
  checkbox?: boolean;
  separatorBefore?: boolean;
}

/** The id of the item that opens the new-watchlist dialog. */
export const NEW_LIST_ITEM = 'new';

export function watchlistSubmenu(
  lists: readonly { id: number; name: string }[],
  members: ReadonlyMap<number, ReadonlySet<string>>,
  pins: readonly number[],
  symbol: string,
): MenuItem[] {
  const pinned = pins.map((id) => lists.find((l) => l.id === id)).filter((l): l is { id: number; name: string } => !!l);
  const rest = lists.filter((l) => !pins.includes(l.id)).sort((a, b) => a.name.localeCompare(b.name));
  const items: MenuItem[] = [...pinned, ...rest].map((l) => ({
    id: String(l.id),
    label: l.name,
    checked: members.get(l.id)?.has(symbol) ?? false,
    checkbox: true,
  }));
  items.push({ id: NEW_LIST_ITEM, label: 'New watchlist…', separatorBefore: items.length > 0 });
  return items;
}

/** `[watchlistId, symbol]` pairs as a map of each list's symbols. */
export function membersByList(pairs: readonly (readonly [number, string])[]): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const [id, symbol] of pairs) {
    let set = out.get(id);
    if (!set) out.set(id, (set = new Set()));
    set.add(symbol);
  }
  return out;
}
