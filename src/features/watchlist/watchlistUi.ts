/** How something outside React (a chart's right-click menu) asks the window to show the
 *  add-to-watchlist dialog. `Workspace` renders it. */

export interface AddToWatchlistOptions {
  /** Open on "a new list" rather than an existing one. */
  newList?: boolean;
}

type Listener = (symbols: string[], options: AddToWatchlistOptions) => void;

const listeners = new Set<Listener>();

export function openAddToWatchlist(symbols: string[], options: AddToWatchlistOptions = {}): void {
  for (const listener of [...listeners]) listener(symbols, options);
}

export function onOpenAddToWatchlist(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
