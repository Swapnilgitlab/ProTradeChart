/** How something outside the watchlist panel tells it that the lists have changed — a Python
 *  script's results being added to one, say. The panel holds its lists in React state, so it
 *  would otherwise show yesterday's until the app restarts. */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Says that a watchlist was made, or symbols added to one. */
export function notifyWatchlistsChanged(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeWatchlistsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
