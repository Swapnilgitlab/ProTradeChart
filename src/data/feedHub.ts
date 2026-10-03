import { listen } from '@tauri-apps/api/event';
import type { FeedStatus } from '../lib/ipc';
import { notify } from './events';

/** The webview end of a broker's live feed. The Rust backend owns the one
 *  WebSocket (brokers cap how many a user may open); it broadcasts every tick
 *  and status change as an event to all windows. A hub listens for those events
 *  once and fans the ticks out to whichever charts subscribed to that
 *  instrument. Each streaming broker gets its own hub. */

export interface FeedHubConfig<Tick> {
  /** The Tauri event carrying ticks, e.g. `zerodha-tick`. */
  tickEvent: string;
  /** The Tauri event carrying status changes, e.g. `zerodha-status`. */
  statusEvent: string;
  /** Which subscribers a tick is for. */
  keyOf: (tick: Tick) => string;
  /** The backend's current feed status, for a window opened after it connected. */
  loadStatus: () => Promise<FeedStatus>;
}

export interface FeedHub<Tick> {
  /** Calls `cb` for every tick of the instrument `key` names. Returns an unsubscribe function. */
  onTick: (key: string, cb: (tick: Tick) => void) => () => void;
  /** Calls `cb` now with the latest status, and again on every change. */
  onStatus: (cb: (status: FeedStatus) => void) => () => void;
}

export function createFeedHub<Tick>(config: FeedHubConfig<Tick>): FeedHub<Tick> {
  const tickListeners = new Map<string, Set<(tick: Tick) => void>>();
  const statusListeners = new Set<(status: FeedStatus) => void>();
  let lastStatus: FeedStatus = { state: 'idle', message: null };
  let started: Promise<void> | null = null;

  function ensureListening(): Promise<void> {
    started ??= (async () => {
      await listen<Tick>(config.tickEvent, (e) => {
        tickListeners.get(config.keyOf(e.payload))?.forEach((cb) => cb(e.payload));
      });
      await listen<FeedStatus>(config.statusEvent, (e) => {
        lastStatus = e.payload;
        statusListeners.forEach((cb) => cb(e.payload));
        // A failure the user has to act on becomes a toast (once per change: the
        // backend only emits when the status actually changes).
        if (e.payload.state === 'error' && e.payload.message) notify('error', e.payload.message);
      });
      // A window opened after the feed connected still learns its state.
      config
        .loadStatus()
        .then((s) => (lastStatus = s))
        .catch(() => {});
    })();
    return started;
  }

  return {
    onTick(key, cb) {
      void ensureListening();
      let set = tickListeners.get(key);
      if (!set) tickListeners.set(key, (set = new Set()));
      const listeners = set;
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) tickListeners.delete(key);
      };
    },
    onStatus(cb) {
      void ensureListening();
      statusListeners.add(cb);
      cb(lastStatus);
      return () => {
        statusListeners.delete(cb);
      };
    },
  };
}
