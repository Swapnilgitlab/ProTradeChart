import { useCallback, useEffect, useState } from 'react';
import {
  errorMessage,
  marketDataLoadNow,
  marketDataSetKeepLoaded,
  marketDataStatus,
  marketDataStop,
  type MarketDataFinished,
  type MarketDataProgress,
  type MarketDataStatus,
} from '../../lib/ipc';
import { describeSummary } from '../../lib/marketData';
import { subscribe } from '../../python/events';

/** "Keep the market loaded": its status, kept live from its progress and finished events. `notice`
 *  is what the last load (or a refused start) had to say. */
export function useMarketData() {
  const [status, setStatus] = useState<MarketDataStatus | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const reload = useCallback(() => marketDataStatus().then(setStatus).catch(() => {}), []);

  useEffect(() => {
    void reload();
    const offProgress = subscribe<MarketDataProgress>('market-data-progress', (progress) =>
      setStatus((s) => (s?.running ? { ...s, running: { ...s.running, progress } } : s)),
    );
    const offFinished = subscribe<MarketDataFinished>('market-data-finished', (f) => {
      setNotice(f.error ? { text: f.error, error: true } : f.summary ? { text: describeSummary(f.summary), error: false } : null);
      void reload();
    });
    return () => {
      offProgress();
      offFinished();
    };
  }, [reload]);

  const act = useCallback(
    async (action: () => Promise<void>) => {
      setNotice(null);
      try {
        await action();
      } catch (err) {
        setNotice({ text: errorMessage(err), error: true });
      }
      await reload();
    },
    [reload],
  );

  return {
    status,
    notice,
    loadNow: () => act(marketDataLoadNow),
    stop: () => act(marketDataStop),
    setKeepLoaded: (on: boolean) => act(() => marketDataSetKeepLoaded(on)),
  };
}
