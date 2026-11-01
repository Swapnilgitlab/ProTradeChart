import { useCallback, useEffect, useState } from 'react';
import { confirmDelete, confirmSavingPrices } from '../../lib/dialogs';
import {
  errorMessage,
  savedPricesDelete,
  savedPricesSet,
  savedPricesStatus,
  type SavedPricesStatus,
} from '../../lib/ipc';
import { SAVING_NOTICE } from '../../lib/savedPrices';
import { subscribe } from '../../python/events';

/** "Save prices on this computer": its status, re-read when the broker in use changes or a market
 *  load finishes (the file grows). Switching it on asks for the terms notice to be accepted first;
 *  switching it off and deleting ask too, since both delete files. */
export function useSavedPrices() {
  const [status, setStatus] = useState<SavedPricesStatus | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => savedPricesStatus().then(setStatus).catch(() => {}), []);

  useEffect(() => {
    void reload();
    const offSource = subscribe('market-source-changed', () => void reload());
    const offLoaded = subscribe('market-data-finished', () => void reload());
    return () => {
      offSource();
      offLoaded();
    };
  }, [reload]);

  const act = useCallback(async (action: () => Promise<SavedPricesStatus>, done?: string) => {
    setNotice(null);
    setBusy(true);
    try {
      setStatus(await action());
      if (done) setNotice({ text: done, error: false });
    } catch (err) {
      setNotice({ text: errorMessage(err), error: true });
    } finally {
      setBusy(false);
    }
  }, []);

  const setOn = async (on: boolean) => {
    if (on && !(await confirmSavingPrices(SAVING_NOTICE))) return;
    if (
      !on &&
      !(await confirmDelete(
        'Stop saving prices and delete the prices saved on this computer? What is in memory stays until the app closes.',
      ))
    ) {
      return;
    }
    await act(() => savedPricesSet(on), on ? undefined : 'Saved prices deleted.');
  };

  const remove = async () => {
    if (!(await confirmDelete('Delete the prices saved on this computer?'))) return;
    await act(() => savedPricesDelete(), 'Saved prices deleted.');
  };

  return { status, notice, busy, setOn, remove };
}
