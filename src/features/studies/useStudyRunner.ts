import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, runStudy, stopPythonRun } from '../../lib/ipc';
import { onPythonExit, onPythonOutput, onPythonResult } from '../../python/events';
import { parseProgress, type StudyProgress } from '../../studies/progress';
import { parseStudyResult, type StudyResultData } from '../../studies/result';
import type { StudySpec } from '../../studies/spec';
import { storeStudyRun } from './storeRun';

/** Lines of console output kept for a run, to show what went wrong if it fails. */
const LOG_LINES = 60;

export interface RunOutcome {
  /** The result, when the engine sent one (it can, and still exit with an error). */
  data: StudyResultData | null;
  /** Its id once stored, or null when it couldn't be. */
  resultId: string | null;
  error: string | null;
}

export interface ActiveRun {
  id: string;
  startedAt: number;
  /** The Study's name, for the progress line. */
  label: string;
}

interface Tracked extends ActiveRun {
  studyId: string;
  gotResult: boolean;
  data: StudyResultData | null;
  error: string | null;
  storing: Promise<string | null> | null;
  onResult?: (data: StudyResultData) => void;
  onStored?: (data: StudyResultData, id: string) => void;
  resolve: (outcome: RunOutcome) => void;
}

interface Options {
  /** Called whenever a run has been stored, so lists can be re-read. */
  onStored: () => void;
  onStoreError: (message: string) => void;
}

/** Runs Studies with the Python engine, one at a time: the progress, the console tail, and a promise
 *  per run that settles when the engine exits — after its result is stored. Used by Run Study and
 *  by the research queue, which awaits one run before starting the next (the broker's pace is
 *  shared, so running two at once wouldn't be faster). Nothing starts a run but `start`. */
export function useStudyRunner({ onStored, onStoreError }: Options) {
  const [run, setRun] = useState<ActiveRun | null>(null);
  const [progress, setProgress] = useState<StudyProgress | null>(null);
  const [log, setLog] = useState<{ text: string; error: boolean }[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const runRef = useRef<Tracked | null>(null);
  const callbacks = useRef({ onStored, onStoreError });
  callbacks.current = { onStored, onStoreError };

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
        if (step) {
          setProgress(step);
          return;
        }
        if (e.text.trim()) setLog((lines) => [...lines, { text: e.text, error: e.stream === 'stderr' }].slice(-LOG_LINES));
      }),
      onPythonResult((e) => {
        const active = runRef.current;
        if (!active || e.runId !== active.id || e.kind !== 'study') return;
        const data = parseStudyResult(e.data);
        if (!data) {
          active.error = 'The engine sent a result this version of the app can’t read.';
          return;
        }
        active.gotResult = true;
        active.data = data;
        active.onResult?.(data);
        active.storing = storeStudyRun(data, active.studyId)
          .then((id) => {
            active.onStored?.(data, id);
            callbacks.current.onStored();
            return id;
          })
          .catch((err) => {
            callbacks.current.onStoreError(`The results are shown but couldn’t be stored: ${errorMessage(err)}`);
            return null;
          });
      }),
      onPythonExit((e) => {
        const active = runRef.current;
        if (!active || e.runId !== active.id) return;
        runRef.current = null;
        setRun(null);
        let error = active.error;
        if (e.stopped) error = 'Stopped.';
        else if (e.error) error = e.error;
        else if (!error && (e.code !== 0 || !active.gotResult)) error = 'The Study stopped before it finished. What it said is below.';
        void (active.storing ?? Promise.resolve(null)).then((resultId) => active.resolve({ data: active.data, resultId, error }));
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);

  /** Runs `spec`, storing its result under `studyId`. Resolves when the engine has exited; refuses
   *  (resolving with an error) while another run is going. */
  const start = useCallback(
    (spec: StudySpec, studyId: string, hooks: Pick<Tracked, 'onResult' | 'onStored'> = {}): Promise<RunOutcome> => {
      if (runRef.current) return Promise.resolve({ data: null, resultId: null, error: 'Another Study is running.' });
      return new Promise<RunOutcome>((resolve) => {
        const tracked: Tracked = {
          id: crypto.randomUUID(),
          startedAt: Date.now(),
          label: spec.name,
          studyId,
          gotResult: false,
          data: null,
          error: null,
          storing: null,
          ...hooks,
          resolve,
        };
        runRef.current = tracked;
        setRun({ id: tracked.id, startedAt: tracked.startedAt, label: tracked.label });
        setNow(tracked.startedAt);
        setProgress({ percent: 0, stage: 'Starting' });
        setLog([]);
        runStudy(JSON.stringify(spec), tracked.id).catch((err) => {
          runRef.current = null;
          setRun(null);
          resolve({ data: null, resultId: null, error: errorMessage(err) });
        });
      });
    },
    [],
  );

  const stop = useCallback(() => {
    const active = runRef.current;
    if (active) stopPythonRun(active.id).catch(() => {});
  }, []);

  return { run, progress, log, now, start, stop };
}
