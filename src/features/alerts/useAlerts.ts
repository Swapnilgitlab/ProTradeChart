import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { listPriceAlerts, type PriceAlert } from '../../lib/ipc';

/** Every price alert, kept current: reloaded whenever any window changes one
 *  (the backend announces each change), so an open list and the toolbar badge
 *  follow alerts firing and edits made elsewhere. */
export function useAlerts(): { alerts: PriceAlert[]; reload: () => Promise<void> } {
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);

  const reload = useCallback(async () => {
    try {
      setAlerts(await listPriceAlerts());
    } catch {
      // The list simply stays as it was; the next change tries again.
    }
  }, []);

  useEffect(() => {
    void reload();
    let off: (() => void) | undefined;
    let cancelled = false;
    void listen('alerts-changed', () => void reload()).then((unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [reload]);

  return { alerts, reload };
}
