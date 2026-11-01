import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, CirclePlay, FilePlus2, FolderOpen, Save, Settings2, Sparkles, Square, Trash2 } from 'lucide-react';
import { useToast } from '../../components/Toasts';
import { useDismiss } from '../../components/useDismiss';
import { confirmDelete, confirmDiscard } from '../../lib/dialogs';
import {
  deletePythonScript,
  errorMessage,
  getPreference,
  listPythonScripts,
  pythonEnvStatus,
  pythonSetupEnv,
  readPythonScript,
  revealPythonFolder,
  runPythonScript,
  savePythonScript,
  setPreference,
  stopPythonRun,
  type PythonEnvStatus,
  type PythonScript,
} from '../../lib/ipc';
import { captureLine, newCapture, type LastRun, type RunCapture } from '../../python/assistant';
import { appendLines, emptyConsole, type ConsoleEntry, type ConsoleState } from '../../python/console';
import { onPythonExit, onPythonOutput, onPythonResult, onPythonSetupDone, onPythonSetupOutput } from '../../python/events';
import { exitSummary, formatElapsed } from '../../python/format';
import { parseResult, type PythonResult } from '../../python/results';
import { STARTER_SCRIPT, withPyExtension } from '../../python/scriptNames';
import { parseStudyResult } from '../../studies/result';
import { storeStudyRun } from '../studies/storeRun';
import { CodeEditor, type CodeEditorHandle } from '../pine/CodeEditor';
import { AddToWatchlistDialog } from './AddToWatchlistDialog';
import { AssistantPane } from './AssistantPane';
import { PythonConsole } from './PythonConsole';
import { pythonExtensions } from './pythonLanguage';
import { PythonSettings } from './PythonSettings';
import { ResultsPane } from './ResultsPane';

const PREF_LAST_SCRIPT = 'python_last_script';
/** Whether the AI assistant pane is open ("1") or closed. */
const PREF_ASSISTANT_OPEN = 'python_assistant_open';
/** Output arrives a line at a time; it is shown a batch at a time, so a script that prints
 *  in a loop doesn't re-render the console thousands of times a second. */
const CONSOLE_BATCH_MS = 30;

interface ActiveRun {
  id: string;
  name: string;
  startedAt: number;
}

interface Props {
  /** Whether the dock is showing. Nothing is loaded (and no example is written, no Python
   *  probed) until the first time it is. */
  visible: boolean;
  /** Opens a symbol a result was clicked on, on the active chart. */
  onOpenSymbol: (symbol: string) => void;
  /** Bumped to open Python settings (the Home tab's "Python setup" card asks for this). */
  openSettings?: number;
  /** Opens the Scheduler with a new schedule that runs this script. */
  onScheduleScript: (script: string) => void;
}

/** The Python workspace: the user's scripts, an editor, a console, and the state of the
 *  Python that runs them. A script runs only when the person presses Run. */
export function PythonPanel({ visible, onOpenSymbol, openSettings, onScheduleScript }: Props) {
  const [env, setEnv] = useState<PythonEnvStatus | null>(null);
  const [scripts, setScripts] = useState<PythonScript[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [saved, setSaved] = useState('');
  const [editorKey, setEditorKey] = useState(0);
  const [consoleState, setConsoleState] = useState<ConsoleState>(emptyConsole);
  const [run, setRun] = useState<ActiveRun | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [settingUp, setSettingUp] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<'console' | 'results'>('console');
  /** Bumped to open a new schedule for the open script. */
  const [results, setResults] = useState<PythonResult[]>([]);
  const [selectedResult, setSelectedResult] = useState<number | null>(null);
  const [adding, setAdding] = useState<string[] | null>(null);
  const [assistOpen, setAssistOpen] = useState(false);
  /** Bumped by Fix with AI. */
  const [fixRequest, setFixRequest] = useState(0);
  /** The last run's ending and output, for the assistant. */
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const capture = useRef<RunCapture | null>(null);
  const editor = useRef<CodeEditorHandle | null>(null);
  const toast = useToast();
  const settingsRef = useRef<HTMLDivElement>(null);
  useDismiss(settingsRef, settingsOpen, () => setSettingsOpen(false));
  useEffect(() => {
    if (openSettings) setSettingsOpen(true);
  }, [openSettings]);
  const nextResultId = useRef(1);

  const runRef = useRef<ActiveRun | null>(null);
  const settingUpRef = useRef(false);
  const loaded = useRef(false);

  // ---- The console ----------------------------------------------------------

  const pending = useRef<ConsoleEntry[]>([]);
  const flushTimer = useRef<number | null>(null);
  const push = useCallback((entries: ConsoleEntry[]) => {
    pending.current.push(...entries);
    if (flushTimer.current !== null) return;
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = null;
      const batch = pending.current;
      pending.current = [];
      setConsoleState((state) => appendLines(state, batch));
    }, CONSOLE_BATCH_MS);
  }, []);
  useEffect(
    () => () => {
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
    },
    [],
  );
  const say = useCallback((level: 'info' | 'error', text: string) => push([{ stream: level, text }]), [push]);

  // ---- Loading ---------------------------------------------------------------

  const refreshEnv = useCallback(async () => {
    try {
      setEnv(await pythonEnvStatus());
    } catch (err) {
      say('error', errorMessage(err));
    }
  }, [say]);

  const refreshScripts = useCallback(async (): Promise<PythonScript[]> => {
    try {
      const list = await listPythonScripts();
      setScripts(list);
      return list;
    } catch (err) {
      say('error', errorMessage(err));
      return [];
    }
  }, [say]);

  const openScript = useCallback(
    async (name: string) => {
      try {
        const text = await readPythonScript(name);
        setCurrent(name);
        setSource(text);
        setSaved(text);
        setEditorKey((k) => k + 1);
        setPreference(PREF_LAST_SCRIPT, name).catch(() => {});
      } catch (err) {
        say('error', errorMessage(err));
      }
    },
    [say],
  );

  // The first time the dock is shown: look for Python, list the scripts, reopen the last one.
  useEffect(() => {
    if (!visible || loaded.current) return;
    loaded.current = true;
    void refreshEnv();
    getPreference(PREF_ASSISTANT_OPEN)
      .then((v) => setAssistOpen(v === '1'))
      .catch(() => {});
    void (async () => {
      const list = await refreshScripts();
      const last = await getPreference(PREF_LAST_SCRIPT).catch(() => null);
      const first = list.find((s) => s.name === last)?.name ?? list[0]?.name;
      if (first) await openScript(first);
    })();
  }, [visible, refreshEnv, refreshScripts, openScript]);

  // Someone who has just installed Python comes back to the window: notice.
  useEffect(() => {
    if (!visible) return;
    const onFocus = () => {
      if (loaded.current && env && env.state !== 'ready' && !settingUpRef.current) void refreshEnv();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [visible, env, refreshEnv]);

  // ---- What the backend tells us ---------------------------------------------------

  useEffect(() => {
    const stops = [
      // Tauri sends these to every window; only this window's own run is shown here.
      onPythonOutput((e) => {
        if (e.runId !== runRef.current?.id) return;
        push([{ stream: e.stream, text: e.text, overwrite: e.overwrite }]);
        if (capture.current) captureLine(capture.current, e.stream, e.text, e.overwrite);
      }),
      onPythonExit((e) => {
        const active = runRef.current;
        if (!active || e.runId !== active.id) return;
        runRef.current = null;
        setRun(null);
        const summary = exitSummary(e, Date.now() - active.startedAt);
        push([{ stream: summary.level, text: summary.text }]);
        const c = capture.current;
        capture.current = null;
        if (c) {
          setLastRun({
            script: c.script,
            failed: summary.level === 'error',
            summary: summary.text.replace(/^[✓✗■]\s*/, ''),
            stdout: c.stdout,
            stderr: c.stderr,
          });
        }
      }),
      onPythonResult((e) => {
        if (e.runId !== runRef.current?.id) return;
        if (e.kind === 'study') {
          // A Study run from a script (a generated one, say): kept with the Studies' results.
          const study = parseStudyResult(e.data);
          if (!study) {
            push([{ stream: 'error', text: 'The script sent a Study result this version of the app can’t read.' }]);
            return;
          }
          storeStudyRun(study, `script:${runRef.current.name}`)
            .then(() => push([{ stream: 'info', text: `✓ Study “${study.spec.name}”: ${study.summary.events} events. Open it in the Studies tab, under Recent results.` }]))
            .catch((err) => push([{ stream: 'error', text: `The Study result couldn’t be stored: ${errorMessage(err)}` }]));
          return;
        }
        const result = parseResult(e, nextResultId.current++);
        if (!result) {
          push([{ stream: 'error', text: `A result of kind "${e.kind}" could not be shown; this version of the app doesn't understand it.` }]);
          return;
        }
        setResults((all) => [...all, result]);
        setSelectedResult(result.id);
        setTab('results');
      }),
      onPythonSetupOutput((e) => {
        if (settingUpRef.current) push([{ stream: e.stream, text: e.text, overwrite: e.overwrite }]);
      }),
      onPythonSetupDone((e) => {
        if (!settingUpRef.current) return;
        settingUpRef.current = false;
        setSettingUp(false);
        push([{ stream: e.ok ? 'info' : 'error', text: `${e.ok ? '✓' : '✗'} ${e.message}` }]);
        void refreshEnv();
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, [push, refreshEnv]);

  useEffect(() => {
    if (!run) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [run]);

  // ---- Actions ---------------------------------------------------------------------

  const dirty = current !== null && source !== saved;

  const save = useCallback(async (): Promise<boolean> => {
    if (!current) return false;
    try {
      await savePythonScript(current, source);
      setSaved(source);
      void refreshScripts();
      return true;
    } catch (err) {
      say('error', errorMessage(err));
      return false;
    }
  }, [current, source, refreshScripts, say]);

  /** Asks before unsaved work is replaced; true means go ahead. */
  const canLeave = useCallback(async () => {
    if (!dirty) return true;
    return confirmDiscard(`"${current}" has unsaved changes. Discard them?`);
  }, [dirty, current]);

  const switchTo = useCallback(
    async (name: string) => {
      if (name === current) return;
      if (await canLeave()) await openScript(name);
    },
    [current, canLeave, openScript],
  );

  const runScript = useCallback(async () => {
    if (!current || runRef.current) return;
    if (env?.state !== 'ready') {
      say('error', env?.message ?? 'Python is still being looked for.');
      return;
    }
    // What runs is what is on screen, so a script is saved first.
    if (source !== saved && !(await save())) return;
    const started: ActiveRun = { id: crypto.randomUUID(), name: current, startedAt: Date.now() };
    runRef.current = started;
    setRun(started);
    setNow(started.startedAt);
    // A run's output belongs with the run, so the last one's results don't linger beside it.
    setResults([]);
    setSelectedResult(null);
    setTab('console');
    push([{ stream: 'info', text: `▶ ${current}` }]);
    capture.current = newCapture(current);
    setLastRun(null);
    try {
      await runPythonScript(current, started.id);
    } catch (err) {
      runRef.current = null;
      capture.current = null;
      setRun(null);
      say('error', errorMessage(err));
    }
  }, [current, env, source, saved, save, push, say]);

  const stopRun = useCallback(() => {
    const active = runRef.current;
    if (active) stopPythonRun(active.id).catch((err) => say('error', errorMessage(err)));
  }, [say]);

  const setup = useCallback(async () => {
    settingUpRef.current = true;
    setSettingUp(true);
    say('info', 'Setting up Python. This can take a minute or two…');
    try {
      await pythonSetupEnv();
    } catch (err) {
      settingUpRef.current = false;
      setSettingUp(false);
      say('error', errorMessage(err));
    }
  }, [say]);

  const createScript = useCallback(async () => {
    const name = withPyExtension(newName);
    setCreating(false);
    setNewName('');
    if (!name) return;
    if (scripts.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      say('error', `There is already a script called ${name}.`);
      return;
    }
    if (!(await canLeave())) return;
    try {
      await savePythonScript(name, STARTER_SCRIPT);
      await refreshScripts();
      await openScript(name);
    } catch (err) {
      say('error', errorMessage(err));
    }
  }, [newName, scripts, canLeave, refreshScripts, openScript, say]);

  const deleteScript = useCallback(
    async (name: string) => {
      if (!(await confirmDelete(`Delete ${name}? This removes the file from the scripts folder.`))) return;
      try {
        await deletePythonScript(name);
        if (name === current) {
          setCurrent(null);
          setSource('');
          setSaved('');
          setEditorKey((k) => k + 1);
        }
        await refreshScripts();
      } catch (err) {
        say('error', errorMessage(err));
      }
    },
    [current, refreshScripts, say],
  );

  const toggleAssistant = useCallback((open: boolean) => {
    setAssistOpen(open);
    setPreference(PREF_ASSISTANT_OPEN, open ? '1' : '0').catch(() => {});
  }, []);

  const fixWithAi = useCallback(() => {
    toggleAssistant(true);
    setFixRequest((n) => n + 1);
  }, [toggleAssistant]);

  /** Apply: the assistant's version goes into the editor as unsaved changes, undoable — never saved or run. */
  const applyProposal = useCallback((code: string) => editor.current?.replaceAll(code), []);

  /** Save as new script: the user's press, with the name they confirmed. */
  const saveAsNew = useCallback(
    async (name: string, code: string): Promise<boolean> => {
      if (scripts.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
        toast(`There is already a script called ${name}.`, 'error');
        return false;
      }
      try {
        await savePythonScript(name, code);
      } catch (err) {
        toast(errorMessage(err), 'error');
        return false;
      }
      await refreshScripts();
      if (await canLeave()) await openScript(name);
      return true;
    },
    [scripts, toast, refreshScripts, canLeave, openScript],
  );

  const ready = env?.state === 'ready';
  const running = run !== null;

  return (
    <div className={`python-panel${assistOpen ? ' assist-open' : ''}`}>
      <aside className="python-side" aria-label="Scripts">
        <div className="python-side-header">
          <span>Scripts</span>
          <button type="button" className="icon-button" aria-label="New script" title="New script" onClick={() => setCreating(true)}>
            <FilePlus2 size={14} />
          </button>
        </div>
        {creating && (
          <input
            className="python-input python-new-name"
            autoFocus
            value={newName}
            placeholder="name.py, then Enter"
            aria-label="New script name"
            spellCheck={false}
            onChange={(e) => setNewName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createScript();
              if (e.key === 'Escape') {
                setCreating(false);
                setNewName('');
              }
            }}
            onBlur={() => {
              if (!newName.trim()) setCreating(false);
            }}
          />
        )}
        <div className="python-side-list">
          {scripts.length === 0 && !creating && <div className="python-side-empty small muted">No scripts yet. Press + to make one.</div>}
          {scripts.map((s) => (
            <div key={s.name} className={`python-script${s.name === current ? ' active' : ''}`}>
              <button type="button" className="python-script-name" onClick={() => void switchTo(s.name)} title={s.name}>
                {s.name}
              </button>
              <button type="button" className="icon-button" aria-label={`Delete ${s.name}`} title="Delete" onClick={() => void deleteScript(s.name)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="python-side-footer small" onClick={() => revealPythonFolder().catch((err) => say('error', errorMessage(err)))}>
          <FolderOpen size={13} />
          Open folder
        </button>
      </aside>

      <div className="python-main">
        <div className="pine-toolbar">
          <span className="python-current" title={current ?? undefined}>
            {current ?? 'No script open'}
          </span>
          {current && <span className={`pine-status${dirty ? ' dirty' : ''}`}>{dirty ? 'Unsaved changes' : 'Saved'}</span>}
          {env?.version && <span className="pine-status">Python {env.version}</span>}

          <div className="pine-toolbar-spacer" />

          <button
            type="button"
            className={`icon-button${assistOpen ? ' active' : ''}`}
            aria-label="AI assistant"
            aria-pressed={assistOpen}
            title="AI assistant: write, change or fix this script"
            onClick={() => toggleAssistant(!assistOpen)}
          >
            <Sparkles size={15} />
          </button>
          <div className="menu-anchor" ref={settingsRef}>
            <button
              type="button"
              className={`icon-button${settingsOpen ? ' active' : ''}`}
              aria-label="Python settings"
              title="Python settings"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((v) => !v)}
            >
              <Settings2 size={15} />
            </button>
            {settingsOpen && <PythonSettings env={env} onEnvChanged={setEnv} say={say} />}
          </div>
          <button
            type="button"
            className="btn pine-btn"
            onClick={() => current && onScheduleScript(current)}
            disabled={!current}
            title="Run this script by itself at set times, alone or in a sequence (opens the Scheduler)"
          >
            <CalendarClock size={14} />
            Schedule
          </button>
          <button type="button" className="btn pine-btn" onClick={() => void save()} disabled={!dirty} title="Save (Ctrl+S)">
            <Save size={14} />
            Save
          </button>
          {running ? (
            <button type="button" className="btn pine-btn python-stop" onClick={stopRun} title="Stop the script">
              <Square size={13} />
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary pine-btn"
              onClick={() => void runScript()}
              disabled={!current || !ready}
              title={ready ? 'Run (Ctrl+Enter)' : (env?.message ?? 'Looking for Python…')}
            >
              <CirclePlay size={14} />
              Run
            </button>
          )}
        </div>

        {env && !ready && (
          <div className="python-banner" role="status">
            <span className="python-banner-text">{env.message}</span>
            {(env.state === 'needsVenv' || env.state === 'needsPackages') && (
              <button type="button" className="btn btn-primary pine-btn" onClick={() => void setup()} disabled={settingUp}>
                {settingUp ? 'Setting up…' : env.state === 'needsVenv' ? 'Set up Python' : 'Install packages'}
              </button>
            )}
            {env.state === 'noPython' && (
              <button type="button" className="btn pine-btn" onClick={() => void refreshEnv()}>
                Check again
              </button>
            )}
          </div>
        )}

        {current ? (
          <CodeEditor
            key={editorKey}
            value={source}
            onChange={setSource}
            onSave={() => void save()}
            onRun={() => void runScript()}
            language={pythonExtensions}
            handleRef={editor}
            placeholderText="Write Python here. import protrade as pt to reach your broker's data."
          />
        ) : (
          <div className="python-empty">
            <p>Open a script on the left, or press + to write one.</p>
            <p className="muted small">
              Scripts run on this computer with your own permissions, the same as from a terminal. Run only code you trust.
            </p>
          </div>
        )}

        <div className="python-output">
          <div className="python-output-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'console'}
              className={`pine-tab${tab === 'console' ? ' active' : ''}`}
              onClick={() => setTab('console')}
            >
              Console
              {run && <span className="python-running" title="Running">{formatElapsed(now - run.startedAt)}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'results'}
              className={`pine-tab${tab === 'results' ? ' active' : ''}`}
              onClick={() => setTab('results')}
            >
              Results
              {results.length > 0 && <span className="pine-tab-count">{results.length}</span>}
            </button>
            {lastRun?.failed && lastRun.script === current && !running && (
              <button type="button" className="btn btn-tiny python-fix" onClick={fixWithAi} title="Send this run's error to the AI assistant and ask it to fix the script">
                <Sparkles size={12} />
                Fix with AI
              </button>
            )}
          </div>
          <div className="python-output-body">
            <div className="python-output-pane" hidden={tab !== 'console'}>
              <PythonConsole
                lines={consoleState.lines}
                runningFor={null}
                onClear={() => setConsoleState(emptyConsole())}
              />
            </div>
            <div className="python-output-pane" hidden={tab !== 'results'}>
              <ResultsPane
                results={results}
                selectedId={selectedResult}
                onSelect={setSelectedResult}
                onClear={() => {
                  setResults([]);
                  setSelectedResult(null);
                }}
                onOpenSymbol={onOpenSymbol}
                onAddToWatchlist={setAdding}
              />
            </div>
          </div>
        </div>
      </div>

      <AssistantPane
        visible={assistOpen}
        current={current}
        source={source}
        scriptNames={scripts.map((s) => s.name)}
        env={env}
        lastRun={lastRun}
        fixRequest={fixRequest}
        onApply={applyProposal}
        onSaveAsNew={saveAsNew}
        onClose={() => toggleAssistant(false)}
        say={toast}
      />

      {adding && <AddToWatchlistDialog symbols={adding} onClose={() => setAdding(null)} say={say} />}
    </div>
  );
}
