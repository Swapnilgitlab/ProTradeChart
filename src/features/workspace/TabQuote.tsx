import { memo, useCallback, useSyncExternalStore } from 'react';
import { getLivePrice, subscribeLivePrice } from '../../data/livePrices';
import { formatPercent, formatPrice } from '../../lib/format';
import { withLivePrice, type TimedQuote } from '../../lib/tabQuote';

interface Props {
  /** The tab's symbol, `provider:TICKER`. */
  symbol: string;
  /** The polled quote (the day's change comes from it), when there is one yet. */
  quote: TimedQuote | undefined;
}

/** The price and the day's change beside a tab's name: `1,592.20 ▼ −0.17%`. It follows the chart's own ticks
 *  (only this label re-renders on a tick) and falls back to the polled quote. Shows nothing until there is a price. */
export const TabQuote = memo(function TabQuote({ symbol, quote }: Props) {
  const subscribe = useCallback((notify: () => void) => subscribeLivePrice(symbol, notify), [symbol]);
  const live = useSyncExternalStore(subscribe, () => getLivePrice(symbol));
  const { price, changePercent } = withLivePrice(quote, live, Date.now());
  if (price == null) return null;

  const direction = changePercent == null || changePercent === 0 ? 'flat' : changePercent < 0 ? 'down' : 'up';
  const arrow = direction === 'up' ? '▲ ' : direction === 'down' ? '▼ ' : '';
  return (
    <span className="tab-chip-quote" title={changePercent == null ? undefined : `${formatPercent(changePercent)} today`}>
      <span className="tab-chip-price">{formatPrice(price)}</span>
      {changePercent != null && (
        <span className={`tab-chip-change ${direction}`}>
          {arrow}
          {formatPercent(changePercent)}
        </span>
      )}
    </span>
  );
});
