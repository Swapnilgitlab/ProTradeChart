import { fyersStatus, type FyersTick } from '../lib/ipc';
import { createFeedHub } from './feedHub';

/** The webview end of FYERS's live charts. The Rust backend polls FYERS's quotes for every subscribed
 *  symbol (`fyers/poller.rs`) and sends each one's last trade as an event; this hub fans them out to
 *  whichever charts show that symbol. */

const hub = createFeedHub<FyersTick>({
  tickEvent: 'fyers-tick',
  statusEvent: 'fyers-status',
  keyOf: (t) => t.ticker,
  loadStatus: () => fyersStatus().then((s) => s.feed),
});

/** Calls `cb` for every polled quote of one ticker (`NSE:RELIANCE`). Returns an unsubscribe function. */
export function onFyersTick(ticker: string, cb: (tick: FyersTick) => void): () => void {
  return hub.onTick(ticker, cb);
}

export const onFyersStatus = hub.onStatus;
