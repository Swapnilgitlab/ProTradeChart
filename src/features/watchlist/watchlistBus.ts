import { listen } from '@tauri-apps/api/event';

/** How something outside the watchlist panel tells it that the lists have changed — a Python
 *  script's results being added to one, say. The panel holds its lists in React state, so it
 *  would otherwise show yesterday's until the app restarts. */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Says that a watchlist was made, or symbols added to one. */
export function notifyWatchlistsChanged(): void {
  for (const listener of [...listeners]) listener();
}

/** Calls `listener` when a watchlist changes — in this window, or in the backend (a script's
 *  `pt.set_watchlist`, perhaps run by a schedule, sends `watchlists-changed` to every window). */
export function subscribeWatchlistsChanged(listener: Listener): () => void {
  listeners.add(listener);
  let cancelled = false;
  let unlisten: (() => void) | null = null;
  void listen('watchlists-changed', () => listener()).then((stop) => {
    if (cancelled) stop();
    else unlisten = stop;
  });
  return () => {
    cancelled = true;
    unlisten?.();
    listeners.delete(listener);
  };
}
