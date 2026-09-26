import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { AiAnswer, AiProgressEvent } from '../../lib/ipc';

/** One Claude request at a time, with its streamed progress: `call` hands the request a fresh id
 *  and follows the `ai-progress` events carrying it. */
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

  const call = useCallback(async (send: (requestId: string) => Promise<AiAnswer>): Promise<AiAnswer> => {
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
