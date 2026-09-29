import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, runScreen, stopPythonRun } from '../../lib/ipc';
import { onPythonExit, onPythonOutput, onPythonResult } from '../../python/events';
import { parseScreenResult, type ScreenResult } from '../../screener/result';
import type { ScreenSpec } from '../../screener/spec';
import { parseProgress, type StudyProgress } from '../../studies/progress';

/** Lines of console output kept for a run, to show what went wrong if it fails. */
const LOG_LINES = 40;

export interface ScreenRun {
  id: string;
  startedAt: number;
}

interface Tracked extends ScreenRun {
  result: ScreenResult | null;
  error: string | null;
  onResult: (result: ScreenResult, raw: unknown) => void;
  onDone: (error: string | null) => void;
}

/** Runs screens with the Python engine, one at a time: the progress, the console tail, and the
 *  result. The engine's progress lines and events are the Studies' (`python-*`, `[progress]`).
 *  Nothing starts a run but `start`, which only the Run button calls. */
export function useScreenRunner() {
  const [run, setRun] = useState<ScreenRun | null>(null);
  const [progress, setProgress] = useState<StudyProgress | null>(null);
  const [log, setLog] = useState<{ text: string; error: boolean }[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const runRef = useRef<Tracked | null>(null);

  useEffect(() => {
    if (!run) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [run]);

  useEffect(() => {
    const stops = [
      onPythonOutput((e) => {
        if (e.runId !== runRef.current?.id) return;
        const step = parseProgress(e.text);
        if (step) setProgress(step);
        else if (e.text.trim()) setLog((lines) => [...lines, { text: e.text, error: e.stream === 'stderr' }].slice(-LOG_LINES));
      }),
      onPythonResult((e) => {
        const active = runRef.current;
        if (!active || e.runId !== active.id || e.kind !== 'screen') return;
        const result = parseScreenResult(e.data);
        if (!result) {
          active.error = 'The engine sent a result this version of the app can’t read. Restart the app so it runs the current engine.';
          return;
        }
        active.result = result;
        active.onResult(result, e.data);
      }),
      onPythonExit((e) => {
        const active = runRef.current;
        if (!active || e.runId !== active.id) return;
        runRef.current = null;
        setRun(null);
        let error = active.error;
        if (e.stopped) error = 'Stopped.';
        else if (e.error) error = e.error;
        else if (!error && (e.code !== 0 || !active.result)) error = 'The screen stopped before it finished. What it said is below.';
        active.onDone(error);
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);

  /** Runs `spec`. `onResult` gets the checked result (and what the engine sent, to store); `onDone` is called once the engine has exited,
   *  with what went wrong, if anything. Refuses while another screen is running. */
  const start = useCallback((spec: ScreenSpec, onResult: Tracked['onResult'], onDone: (error: string | null) => void) => {
    if (runRef.current) {
      onDone('Another screen is running.');
      return;
    }
    const tracked: Tracked = { id: crypto.randomUUID(), startedAt: Date.now(), result: null, error: null, onResult, onDone };
    runRef.current = tracked;
    setRun({ id: tracked.id, startedAt: tracked.startedAt });
    setNow(tracked.startedAt);
    setProgress({ percent: 0, stage: 'Starting' });
    setLog([]);
    runScreen(JSON.stringify(spec), tracked.id).catch((err) => {
      runRef.current = null;
      setRun(null);
      onDone(errorMessage(err));
    });
  }, []);

  const stop = useCallback(() => {
    const active = runRef.current;
    if (active) stopPythonRun(active.id).catch(() => {});
  }, []);

  return { run, progress, log, now, start, stop };
}
