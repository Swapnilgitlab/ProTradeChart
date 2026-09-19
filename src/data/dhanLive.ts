import { dhanStatus, type DhanTick } from '../lib/ipc';
import { createFeedHub } from './feedHub';

/** The webview end of Dhan's live feed. The Rust backend owns the one
 *  WebSocket (Dhan allows only 5 per user); this hub fans its ticks out to
 *  whichever charts subscribed to that instrument. */

const keyOf = (segment: number, securityId: number) => `${segment}:${securityId}`;

const hub = createFeedHub<DhanTick>({
  tickEvent: 'dhan-tick',
  statusEvent: 'dhan-status',
  keyOf: (t) => keyOf(t.segment, t.securityId),
  loadStatus: () => dhanStatus().then((s) => s.feed),
});

/** Calls `cb` for every tick of one instrument. Returns an unsubscribe function. */
export function onDhanTick(segment: number, securityId: number, cb: (tick: DhanTick) => void): () => void {
  return hub.onTick(keyOf(segment, securityId), cb);
}

export const onDhanStatus = hub.onStatus;
