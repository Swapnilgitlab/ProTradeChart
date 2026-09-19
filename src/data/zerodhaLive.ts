import { zerodhaStatus, type ZerodhaTick } from '../lib/ipc';
import { createFeedHub } from './feedHub';

/** The webview end of Zerodha's live feed. The Rust backend owns the one
 *  WebSocket (a Kite API key may open only 3); this hub fans its ticks out to
 *  whichever charts subscribed to that instrument. */

const hub = createFeedHub<ZerodhaTick>({
  tickEvent: 'zerodha-tick',
  statusEvent: 'zerodha-status',
  keyOf: (t) => String(t.token),
  loadStatus: () => zerodhaStatus().then((s) => s.feed),
});

/** Calls `cb` for every tick of one instrument token. Returns an unsubscribe function. */
export function onZerodhaTick(token: number, cb: (tick: ZerodhaTick) => void): () => void {
  return hub.onTick(String(token), cb);
}

export const onZerodhaStatus = hub.onStatus;
