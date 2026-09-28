import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { AiProgressEvent } from '../../lib/ipc';

/** One AI request at a time, with its streamed progress: `call` hands the request a fresh id and
 *  follows the `ai-progress` events carrying it. Generic over the answer shape — Study Builder
 *  calls return `AiAnswer`, Ask AI's return `AskAiAnswer`; this only cares that there is one. */
export function useAiRequest() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<AiProgressEvent | null>(null);
  const current = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<AiProgressEvent>('ai-progress', (e) => {
      if (!cancelled && e.payload.requestId === current.current) setProgress(e.payload);
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const call = useCallback(async <T>(send: (requestId: string) => Promise<T>): Promise<T> => {
    const id = crypto.randomUUID();
    current.current = id;
    setBusy(true);
    setProgress(null);
    try {
      return await send(id);
    } finally {
      if (current.current === id) {
        current.current = null;
        setBusy(false);
        setProgress(null);
      }
    }
  }, []);

  return { busy, progress, call };
}
