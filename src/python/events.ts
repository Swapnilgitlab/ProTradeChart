import { listen } from '@tauri-apps/api/event';
import type {
  PythonExitEvent,
  PythonOutputEvent,
  PythonResultEvent,
  PythonSetupDoneEvent,
  PythonSetupOutputEvent,
} from '../lib/ipc';

/** Subscribes to one of the backend's Python events. Returns the unsubscribe function
 *  straight away: `listen` is asynchronous, so leaving before it has registered still
 *  removes the listener. Tauri sends these events to every window; a caller that only
 *  wants its own run's output filters on `runId`. */
function subscribe<T>(event: string, callback: (payload: T) => void): () => void {
  let cancelled = false;
  let unlisten: (() => void) | null = null;
  void listen<T>(event, (e) => {
    if (!cancelled) callback(e.payload);
  }).then((stop) => {
    if (cancelled) stop();
    else unlisten = stop;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

export const onPythonOutput = (cb: (e: PythonOutputEvent) => void) => subscribe('python-output', cb);
export const onPythonExit = (cb: (e: PythonExitEvent) => void) => subscribe('python-exit', cb);
export const onPythonResult = (cb: (e: PythonResultEvent) => void) => subscribe('python-result', cb);
export const onPythonSetupOutput = (cb: (e: PythonSetupOutputEvent) => void) => subscribe('python-setup-output', cb);
export const onPythonSetupDone = (cb: (e: PythonSetupDoneEvent) => void) => subscribe('python-setup-done', cb);
