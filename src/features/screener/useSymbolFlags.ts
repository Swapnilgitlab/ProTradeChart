import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../components/Toasts';
import { errorMessage, getSymbolFlags, setSymbolFlag, type WatchlistFlag } from '../../lib/ipc';
import { subscribeWatchlistsChanged } from '../watchlist/watchlistBus';

/** The flags of a screen's matches, and a way to set one. A flag is the symbol's own (`symbol_flags`),
 *  so setting it here shows on every watchlist; a flag changed elsewhere (a watchlist, a script) is
 *  picked up through the same `watchlists-changed` signal the watchlist panel listens to. */
export function useSymbolFlags(symbols: readonly string[]) {
  const toast = useToast();
  const [flags, setFlags] = useState<Record<string, WatchlistFlag>>({});
  const symbolsRef = useRef(symbols);
  symbolsRef.current = symbols;
  const key = symbols.join('\n');

  const load = useCallback(() => {
    const asked = [...symbolsRef.current];
    if (asked.length === 0) {
      setFlags({});
      return;
    }
    getSymbolFlags(asked)
      .then((found) => {
        if (symbolsRef.current.join('\n') === asked.join('\n')) setFlags(found);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    return subscribeWatchlistsChanged(load);
  }, [key, load]);

  const setFlag = useCallback(
    (symbol: string, flag: WatchlistFlag | null) => {
      setFlags((prev) => {
        const next = { ...prev };
        if (flag) next[symbol] = flag;
        else delete next[symbol];
        return next;
      });
      setSymbolFlag(symbol, flag).catch((err) => {
        toast(errorMessage(err), 'error');
        load();
      });
    },
    [load, toast],
  );

  return { flags, setFlag };
}
