import { useCallback, useEffect, useState } from 'react';
import { deletePineScript, errorMessage, listPineScripts, savePineScript, type PineScriptKind, type PineScriptRow } from '../../lib/ipc';
import { useToast } from '../../components/Toasts';

export interface ScriptInput {
  id: string;
  name: string;
  kind: PineScriptKind;
  source: string;
}

/** The saved Pine library: the list, plus save and delete that keep it current. Failures
 *  are toasted here and reported as `false`, so callers only decide what to do next. */
export function usePineScripts() {
  const toast = useToast();
  const [scripts, setScripts] = useState<PineScriptRow[]>([]);

  const refresh = useCallback(async () => {
    setScripts(await listPineScripts());
  }, []);

  useEffect(() => {
    refresh().catch((err) => toast(`Couldn't load your scripts: ${errorMessage(err)}`, 'error'));
  }, [refresh, toast]);

  const save = useCallback(
    async (input: ScriptInput): Promise<boolean> => {
      try {
        await savePineScript({ ...input, createdAt: '', updatedAt: '' });
        await refresh();
        return true;
      } catch (err) {
        toast(`Couldn't save the script: ${errorMessage(err)}`, 'error');
        return false;
      }
    },
    [refresh, toast],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await deletePineScript(id);
        await refresh();
        return true;
      } catch (err) {
        toast(`Couldn't delete the script: ${errorMessage(err)}`, 'error');
        return false;
      }
    },
    [refresh, toast],
  );

  return { scripts, save, remove };
}
