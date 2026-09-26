import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, BookPlus, ChevronDown, CirclePlay, Code2, Copy, Download, FilePlus2, GitCompare, Pencil, Plus, Save, Square, Trash2, X } from 'lucide-react';
import type { StudyEvent } from '../../chart/studyEvent';
import { useDismiss } from '../../components/useDismiss';
import { useToast } from '../../components/Toasts';
import { confirmDelete, confirmDiscard } from '../../lib/dialogs';
import {
  deleteStudy,
  deleteStudyResult,
  errorMessage,
  exportStudyFile,
  addNotebookItem,
  getStudyResult,
  getWatchlist,
  listNotebooks,
  saveNotebook,
  listStudies,
  listStudyResults,
  listWatchlists,
  pythonEnvStatus,
  runStudy,
  saveStudy,
  stopPythonRun,
  studyEstimate,
  type NotebookItemKind,
  type NotebookSummary,
  type PythonEnvStatus,
  type StudyExportKind,
  type StudyResultInfo,
  type StudyRow,
} from '../../lib/ipc';
import { onPythonExit, onPythonOutput, onPythonResult } from '../../python/events';
import { formatElapsed } from '../../python/format';
import { generatePython, scriptName } from '../../studies/codegen';
import { eventsCsv, metricsCsv, reportMarkdown, resultJson, specJson, stocksCsv } from '../../studies/exports';
import { parseProgress, type StudyProgress } from '../../studies/progress';
import { applyFix, checkReadiness, loadFrom, type ReadinessFix, type UniverseEstimate } from '../../studies/readiness';
import { parseRunSummary, parseStudyResult, type StudyResultData } from '../../studies/result';
import { normalizeSpec, specProblem, type StudySpec } from '../../studies/spec';
import { fromTemplate, TEMPLATES } from '../../studies/templates';
import { useProviderState } from '../providers/useProviderState';
import { AddToWatchlistDialog } from '../python/AddToWatchlistDialog';
import { AssistantPanel, ResultExplainer } from './AssistantPanel';
import { CompareView, type ComparedRun } from './CompareView';
import { NotebookView } from './NotebookView';
import { PythonDialog } from './PythonDialog';
import { storeStudyRun } from './storeRun';
import { StudyBuilder } from './StudyBuilder';
import { StudyResults } from './StudyResults';

interface Props {
  /** Whether the tab is showing. Nothing is loaded until it first is. */
  visible: boolean;
  onOpenEvent: (event: StudyEvent) => void;
  onOpenPython: () => void;
}

interface Current {
  id: string;
  spec: StudySpec;
  /** The spec as last saved or as opened (normalised JSON): what "unsaved changes" is judged against. */
  baseline: string | null;
  /** Whether it is one of My Studies. */
  isSaved: boolean;
}

interface ActiveRun {
  id: string;
  startedAt: number;
  gotResult: boolean;
}

/** Lines of console output kept for a run, to show what went wrong if it fails. */
const LOG_LINES = 60;

function fresh(templateId = 'winners_100'): Current {
  const spec = fromTemplate(templateId);
  return { id: crypto.randomUUID(), spec, baseline: JSON.stringify(spec), isSaved: false };
}

function savedForm(spec: StudySpec): string | null {
  try {
    return JSON.stringify(normalizeSpec(spec));
  } catch {
    return null;
  }
}

/** The Studies workspace: My Studies, templates and past runs on the left; the Study Builder or a
 *  run's results on the right. A Study runs only when Run Study is pressed. */
export function StudiesPanel({ visible, onOpenEvent, onOpenPython }: Props) {
  const toast = useToast();
  const { providers } = useProviderState();
  const [studies, setStudies] = useState<StudyRow[]>([]);
  const [runs, setRuns] = useState<StudyResultInfo[]>([]);
  const [watchlistRows, setWatchlistRows] = useState<{ id: number; name: string }[]>([]);
  const watchlists = useMemo(() => watchlistRows.map((w) => w.name), [watchlistRows]);
  const [estimate, setEstimate] = useState<UniverseEstimate | null>(null);
  const [env, setEnv] = useState<PythonEnvStatus | null>(null);
  const [current, setCurrent] = useState<Current>(() => fresh());
  const [view, setView] = useState<'build' | 'results' | 'compare' | 'notebook'>('build');
  const [notebooks, setNotebooks] = useState<NotebookSummary[]>([]);
  const [openNotebook, setOpenNotebook] = useState<string | null>(null);
  /** The first of two results picked to compare, waiting for the second. */
  const [comparePick, setComparePick] = useState<{ id: string; name: string } | null>(null);
  const [comparing, setComparing] = useState<{ a: ComparedRun; b: ComparedRun } | null>(null);
  const [notebookMenu, setNotebookMenu] = useState(false);
  const notebookRef = useRef<HTMLDivElement>(null);
  useDismiss(notebookRef, notebookMenu, () => setNotebookMenu(false));
  const [result, setResult] = useState<{ id: string | null; data: StudyResultData } | null>(null);
  const [run, setRun] = useState<ActiveRun | null>(null);
  const [progress, setProgress] = useState<StudyProgress | null>(null);
  const [log, setLog] = useState<{ text: string; error: boolean }[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [exportOpen, setExportOpen] = useState(false);
  const [pythonOpen, setPythonOpen] = useState(false);
  const [adding, setAdding] = useState<string[] | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  useDismiss(exportRef, exportOpen, () => setExportOpen(false));
  const loaded = useRef(false);
  const runRef = useRef<ActiveRun | null>(null);
  const currentRef = useRef(current);
  currentRef.current = current;

  const problem = useMemo(() => specProblem(current.spec), [current.spec]);
  const dirty = savedForm(current.spec) !== current.baseline;
  // What the universe will cost to load, re-read as the spec changes (after a pause in typing).
  // Only the parts it depends on are keyed, so editing a metric doesn't ask again.
  const estimateKey = useMemo(() => {
    if (problem) return null;
    const spec = normalizeSpec(current.spec);
    return JSON.stringify({ universe: spec.universe, from: loadFrom(spec) });
  }, [problem, current.spec]);
  useEffect(() => {
    if (!visible || !estimateKey) {
      setEstimate(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const { universe: u, from } = JSON.parse(estimateKey) as { universe: StudySpec['universe']; from: string };
        let symbols: string[] | null = null;
        if (u.source === 'symbols') symbols = u.symbols;
        if (u.source === 'watchlist') {
          const row = watchlistRows.find((w) => w.name.toLowerCase() === (u.watchlist ?? '').toLowerCase());
          if (!row) return;
          symbols = (await getWatchlist(row.id)).items.map((i) => i.symbol).filter((sym) => /^(zerodha|dhan):/.test(sym));
        }
        const result = await studyEstimate({
          provider: u.provider,
          exchanges: u.exchanges,
          series: u.series,
          symbols,
          // The first bar loaded, at midnight IST, as the engine asks for it.
          fromMs: Date.parse(`${from}T00:00:00+05:30`),
          maxSymbols: u.max_symbols,
        });
        if (!cancelled) setEstimate(result);
      } catch {
        if (!cancelled) setEstimate(null);
      }
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // A finished run changes what is stored, so the estimate is read again then too.
  }, [visible, estimateKey, watchlistRows, run === null]);

  const readiness = useMemo(() => {
    if (problem) return null;
    return checkReadiness(normalizeSpec(current.spec), {
      providers: providers.map((p) => ({ id: p.id, usable: p.enabled && p.configured })),
      pythonReady: env?.state === 'ready',
      pythonMessage: env?.message ?? 'Looking for Python…',
      watchlists,
      today: new Date().toISOString().slice(0, 10),
      estimate,
    });
  }, [problem, current.spec, providers, env, watchlists, estimate]);

  const refresh = useCallback(async () => {
    try {
      const [s, r, n] = await Promise.all([listStudies(), listStudyResults(null), listNotebooks()]);
      setStudies(s);
      setRuns(r);
      setNotebooks(n);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }, [toast]);

  useEffect(() => {
    if (!visible || loaded.current) return;
    loaded.current = true;
    void refresh();
    pythonEnvStatus().then(setEnv).catch(() => {});
    listWatchlists()
      .then((lists) => setWatchlistRows(lists.map((l) => ({ id: l.id, name: l.name }))))
      .catch(() => {});
  }, [visible, refresh]);

  // Python may have been set up in the Python tab meanwhile.
  useEffect(() => {
    if (visible && loaded.current && env?.state !== 'ready') pythonEnvStatus().then(setEnv).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (!run) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [run]);

  // ---- What the engine reports -----------------------------------------------------------

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
        if (!active || e.runId !== active.id) return;
        if (e.kind !== 'study') return;
        const data = parseStudyResult(e.data);
        if (!data) {
          setFailed('The engine sent a result this version of the app can’t read.');
          return;
        }
        active.gotResult = true;
        setResult({ id: null, data });
        setView('results');
        storeStudyRun(data, currentRef.current.id)
          .then((id) => {
            setResult((r) => (r && r.data === data ? { ...r, id } : r));
            void refresh();
          })
          .catch((err) => toast(`The results are shown but couldn’t be stored: ${errorMessage(err)}`, 'error'));
      }),
      onPythonExit((e) => {
        const active = runRef.current;
        if (!active || e.runId !== active.id) return;
        runRef.current = null;
        setRun(null);
        if (e.stopped) setFailed('Stopped.');
        else if (e.error) setFailed(e.error);
        else if (e.code !== 0 || !active.gotResult) setFailed('The Study stopped before it finished. What it said is below.');
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, [refresh, toast]);

  // ---- Actions ---------------------------------------------------------------------------

  /** Asks before edits are thrown away; an untouched template or saved Study goes without asking. */
  const canLeave = useCallback(async () => {
    if (!dirty) return true;
    return confirmDiscard(`"${current.spec.name}" has changes that aren’t saved. Discard them?`);
  }, [dirty, current.spec.name]);

  const startRun = useCallback(async () => {
    if (runRef.current || problem || !readiness?.ready) return;
    const spec = normalizeSpec(current.spec);
    const started: ActiveRun = { id: crypto.randomUUID(), startedAt: Date.now(), gotResult: false };
    runRef.current = started;
    setRun(started);
    setNow(started.startedAt);
    setProgress({ percent: 0, stage: 'Starting' });
    setLog([]);
    setFailed(null);
    try {
      await runStudy(JSON.stringify(spec), started.id);
    } catch (err) {
      runRef.current = null;
      setRun(null);
      setFailed(errorMessage(err));
    }
  }, [current.spec, problem, readiness]);

  const save = useCallback(async () => {
    if (problem) {
      toast(`Can’t save yet: ${problem}`, 'error');
      return;
    }
    const spec = normalizeSpec(current.spec);
    const json = JSON.stringify(spec);
    try {
      await saveStudy({ id: current.id, name: spec.name, specJson: json, createdAt: '', updatedAt: '' });
      setCurrent((c) => ({ ...c, spec, baseline: json, isSaved: true }));
      await refresh();
      toast(`Saved “${spec.name}”.`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }, [current, problem, refresh, toast]);

  const openStudy = async (row: StudyRow) => {
    if (row.id === current.id) {
      setView('build');
      return;
    }
    if (!(await canLeave())) return;
    try {
      const spec = normalizeSpec(JSON.parse(row.specJson));
      setCurrent({ id: row.id, spec, baseline: JSON.stringify(spec), isSaved: true });
      setView('build');
      setResult(null);
      setFailed(null);
    } catch (err) {
      toast(`“${row.name}” couldn’t be opened: ${errorMessage(err)}`, 'error');
    }
  };

  const openTemplate = async (id: string) => {
    if (!(await canLeave())) return;
    setCurrent(fresh(id));
    setView('build');
    setResult(null);
    setFailed(null);
  };

  // The builder is what shows whenever the chosen view has nothing to show.
  const builderShown = !((view === 'compare' && comparing) || (view === 'notebook' && openNotebook) || (view === 'results' && result));

  /** A proposal from Claude, opened as a new Study that isn't saved until Save is pressed. */
  const openProposal = async (spec: StudySpec) => {
    if (!(await canLeave())) return;
    setCurrent({ id: crypto.randomUUID(), spec, baseline: null, isSaved: false });
    setView('build');
    setResult(null);
    setFailed(null);
  };

  const duplicate = () => {
    setCurrent((c) => ({ id: crypto.randomUUID(), spec: { ...structuredClone(c.spec), name: `${c.spec.name} (copy)`.slice(0, 120) }, baseline: null, isSaved: false }));
    setResult(null);
    setView('build');
  };

  const removeStudy = async (row: StudyRow) => {
    if (!(await confirmDelete(`Delete the Study “${row.name}” and its stored results?`))) return;
    try {
      await deleteStudy(row.id);
      if (row.id === current.id) setCurrent((c) => ({ ...c, baseline: null, isSaved: false }));
      await refresh();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  /** A stored run, read and checked, for the compare view. */
  const loadRun = async (id: string): Promise<ComparedRun | null> => {
    const row = await getStudyResult(id);
    const data = row ? parseStudyResult(JSON.parse(row.resultJson)) : null;
    return row && data ? { id: row.id, name: row.name, executedAt: row.executedAt, data } : null;
  };

  /** Picks a result to compare: the first waits for a second, the second opens the comparison. */
  const compareWith = async (id: string, name: string) => {
    if (!comparePick || comparePick.id === id) {
      setComparePick({ id, name });
      return;
    }
    try {
      const [a, b] = await Promise.all([loadRun(comparePick.id), loadRun(id)]);
      if (!a || !b) {
        toast('One of those results can’t be read by this version of the app.', 'error');
        return;
      }
      setComparing({ a, b });
      setComparePick(null);
      setView('compare');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const newNotebook = async (): Promise<string | null> => {
    const id = crypto.randomUUID();
    try {
      await saveNotebook(id, `Research notebook ${notebooks.length + 1}`, '');
      await refresh();
      return id;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return null;
    }
  };

  const showNotebook = (id: string) => {
    setOpenNotebook(id);
    setView('notebook');
  };

  /** Adds the open Study (it must be saved: a notebook refers to it by id) or the result on screen. */
  const addToNotebook = async (notebookId: string | null, kind: NotebookItemKind) => {
    setNotebookMenu(false);
    const target = notebookId ?? (await newNotebook());
    if (!target) return;
    const refId = kind === 'result' ? result?.id : current.id;
    if (!refId) return;
    if (kind === 'study' && !current.isSaved) {
      toast('Save the Study first, so the notebook can find it again.', 'info');
      return;
    }
    try {
      await addNotebookItem(target, kind, refId);
      await refresh();
      toast(`Added to “${notebooks.find((n) => n.id === target)?.name ?? 'the new notebook'}”.`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const openStudyById = async (id: string) => {
    const row = studies.find((s) => s.id === id);
    if (row) await openStudy(row);
    else toast('That Study no longer exists.', 'info');
  };

  const openRun = async (info: StudyResultInfo) => {
    try {
      const row = await getStudyResult(info.id);
      const data = row ? parseStudyResult(JSON.parse(row.resultJson)) : null;
      if (!data) {
        toast('That result can’t be read by this version of the app.', 'error');
        return;
      }
      if (info.studyId !== current.id) {
        if (!(await canLeave())) return;
        const savedRow = studies.find((s) => s.id === info.studyId);
        setCurrent({
          id: info.studyId,
          spec: data.spec,
          baseline: savedRow ? savedForm(JSON.parse(savedRow.specJson)) : JSON.stringify(data.spec),
          isSaved: !!savedRow,
        });
      }
      setResult({ id: info.id, data });
      setView('results');
      setFailed(null);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const removeRun = async (info: StudyResultInfo) => {
    if (!(await confirmDelete(`Delete the stored result of “${info.name}” from ${info.executedAt.slice(0, 16).replace('T', ' ')}?`))) return;
    try {
      await deleteStudyResult(info.id);
      if (result?.id === info.id) setResult(null);
      await refresh();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const doExport = async (kind: StudyExportKind, suffix: string, contents: string) => {
    setExportOpen(false);
    try {
      const path = await exportStudyFile(`${current.spec.name}${suffix}`, kind, contents);
      if (path) toast(`Saved ${path}`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const running = run !== null;
  const canRun = !problem && !!readiness?.ready && !running;
  const runTitle = problem ?? (readiness && !readiness.ready ? readiness.items.find((i) => i.blocking)?.detail : undefined) ?? 'Run the Study';
  const studyRuns = runs.filter((r) => r.studyId === current.id);

  return (
    <div className="studies-panel">
      <aside className="python-side studies-side" aria-label="Studies">
        <div className="python-side-header">
          <span>My Studies</span>
          <button type="button" className="icon-button" aria-label="New Study" title="New Study (Custom)" onClick={() => void openTemplate('custom')}>
            <FilePlus2 size={14} />
          </button>
        </div>
        <div className="python-side-list studies-side-list">
          {studies.length === 0 && <div className="python-side-empty small muted">No saved Studies yet. Start from a template below.</div>}
          {studies.map((s) => (
            <div key={s.id} className={`python-script${s.id === current.id ? ' active' : ''}`}>
              <button type="button" className="python-script-name" title={s.name} onClick={() => void openStudy(s)}>
                {s.name}
              </button>
              <button type="button" className="icon-button" aria-label={`Delete ${s.name}`} title="Delete" onClick={() => void removeStudy(s)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <div className="python-side-header studies-subhead">Templates</div>
          {TEMPLATES.map((t) => (
            <div key={t.id} className="python-script">
              <button type="button" className="python-script-name" title={t.summary} onClick={() => void openTemplate(t.id)}>
                {t.name}
              </button>
            </div>
          ))}
          <div className="python-side-header studies-subhead">
            <span>Notebooks</span>
            <button
              type="button"
              className="icon-button"
              aria-label="New notebook"
              title="New notebook"
              onClick={async () => {
                const id = await newNotebook();
                if (id) showNotebook(id);
              }}
            >
              <Plus size={13} />
            </button>
          </div>
          {notebooks.length === 0 && <div className="python-side-empty small muted">Group Studies and results with your notes.</div>}
          {notebooks.map((n) => (
            <div key={n.id} className={`python-script${view === 'notebook' && openNotebook === n.id ? ' active' : ''}`}>
              <button type="button" className="python-script-name studies-run" title={n.name} onClick={() => showNotebook(n.id)}>
                <span>{n.name}</span>
                <span className="muted small">
                  {n.itemCount} item{n.itemCount === 1 ? '' : 's'}
                </span>
              </button>
            </div>
          ))}
          <div className="python-side-header studies-subhead">Recent results</div>
          {runs.length === 0 && <div className="python-side-empty small muted">Results appear here after a run.</div>}
          {runs.slice(0, 30).map((r) => {
            const summary = parseRunSummary(r.summaryJson);
            return (
              <div key={r.id} className={`python-script${result?.id === r.id ? ' active' : ''}`}>
                <button type="button" className="python-script-name studies-run" onClick={() => void openRun(r)} title={r.name}>
                  <span>{r.name}</span>
                  <span className="muted small">
                    {r.executedAt.slice(0, 10)} · {summary?.events ?? '?'} events
                  </span>
                </button>
                <button
                  type="button"
                  className={`icon-button${comparePick?.id === r.id ? ' active' : ''}`}
                  aria-label="Compare with another result"
                  title={comparePick && comparePick.id !== r.id ? `Compare with “${comparePick.name}”` : 'Compare with another result'}
                  onClick={() => void compareWith(r.id, r.name)}
                >
                  <GitCompare size={13} />
                </button>
                <button type="button" className="icon-button" aria-label="Delete this result" title="Delete" onClick={() => void removeRun(r)}>
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      <div className="python-main">
        <div className="pine-toolbar">
          <span className="python-current" title={current.spec.name}>
            {current.spec.name || 'Untitled Study'}
          </span>
          <span className={`pine-status${dirty ? ' dirty' : ''}`}>{!current.isSaved ? 'Not saved' : dirty ? 'Unsaved changes' : 'Saved'}</span>
          <div className="pine-toolbar-spacer" />
          {view !== 'build' ? (
            <button type="button" className="btn pine-btn" onClick={() => setView('build')} title="Edit the Study">
              <Pencil size={14} />
              Edit
            </button>
          ) : (
            result && (
              <button type="button" className="btn pine-btn" onClick={() => setView('results')}>
                Results
              </button>
            )
          )}
          <div className="menu-anchor" ref={notebookRef}>
            <button type="button" className="btn pine-btn" aria-expanded={notebookMenu} onClick={() => setNotebookMenu((v) => !v)} title="Add to a Research Notebook">
              <BookPlus size={14} />
              Notebook
              <ChevronDown size={12} />
            </button>
            {notebookMenu && (
              <div className="menu study-export-menu" role="menu">
                {view === 'results' && result?.id && (
                  <>
                    <div className="menu-heading">Add this result to…</div>
                    {notebooks.map((n) => (
                      <button key={`r${n.id}`} type="button" className="menu-item" role="menuitem" onClick={() => void addToNotebook(n.id, 'result')}>
                        <BookOpen size={13} />
                        {n.name}
                      </button>
                    ))}
                    <button type="button" className="menu-item" role="menuitem" onClick={() => void addToNotebook(null, 'result')}>
                      <Plus size={13} />
                      A new notebook
                    </button>
                    <div className="menu-divider" />
                  </>
                )}
                <div className="menu-heading">Add this Study to…</div>
                {notebooks.map((n) => (
                  <button key={`s${n.id}`} type="button" className="menu-item" role="menuitem" onClick={() => void addToNotebook(n.id, 'study')}>
                    <BookOpen size={13} />
                    {n.name}
                  </button>
                ))}
                <button type="button" className="menu-item" role="menuitem" onClick={() => void addToNotebook(null, 'study')}>
                  <Plus size={13} />
                  A new notebook
                </button>
              </div>
            )}
          </div>
          <button type="button" className="btn pine-btn" onClick={duplicate} title="Duplicate as a new Study">
            <Copy size={14} />
            Duplicate
          </button>
          <button type="button" className="btn pine-btn" onClick={() => void save()} disabled={!dirty && current.isSaved} title="Save the Study">
            <Save size={14} />
            Save
          </button>
          <button type="button" className="btn pine-btn" onClick={() => setPythonOpen(true)} disabled={!!problem} title="Show the Study as Python you can edit">
            <Code2 size={14} />
            Generate Python
          </button>
          <div className="menu-anchor" ref={exportRef}>
            <button type="button" className="btn pine-btn" aria-expanded={exportOpen} onClick={() => setExportOpen((v) => !v)} disabled={!!problem}>
              <Download size={14} />
              Export
              <ChevronDown size={12} />
            </button>
            {exportOpen && !problem && (
              <div className="menu study-export-menu" role="menu">
                <button type="button" className="menu-item" role="menuitem" onClick={() => void doExport('json', ' spec', `${JSON.stringify(normalizeSpec(current.spec), null, 2)}\n`)}>
                  Study Specification (.json)
                </button>
                <button type="button" className="menu-item" role="menuitem" onClick={() => void doExport('py', '', generatePython(normalizeSpec(current.spec)))}>
                  Python ({scriptName(normalizeSpec(current.spec))})
                </button>
                {result && (
                  <>
                    <div className="menu-divider" />
                    <button type="button" className="menu-item" role="menuitem" onClick={() => void doExport('csv', ' events', eventsCsv(result.data))}>
                      Events (.csv)
                    </button>
                    <button type="button" className="menu-item" role="menuitem" onClick={() => void doExport('csv', ' stocks', stocksCsv(result.data))}>
                      Stock summary (.csv)
                    </button>
                    <button type="button" className="menu-item" role="menuitem" onClick={() => void doExport('csv', ' metrics', metricsCsv(result.data))}>
                      Metric statistics (.csv)
                    </button>
                    <button type="button" className="menu-item" role="menuitem" onClick={() => void doExport('json', ' result', resultJson(result.data))}>
                      Full result (.json)
                    </button>
                    <button type="button" className="menu-item" role="menuitem" onClick={() => void doExport('json', ' result spec', specJson(result.data))}>
                      Spec of this result (.json)
                    </button>
                    <button type="button" className="menu-item" role="menuitem" onClick={() => void doExport('md', ' report', reportMarkdown(result.data))}>
                      Report (.md)
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {running ? (
            <button type="button" className="btn pine-btn python-stop" onClick={() => run && stopPythonRun(run.id).catch(() => {})}>
              <Square size={13} />
              Stop
            </button>
          ) : (
            <button type="button" className="btn btn-primary pine-btn" onClick={() => void startRun()} disabled={!canRun} title={runTitle}>
              <CirclePlay size={14} />
              {result && view === 'results' ? 'Rerun' : 'Run Study'}
            </button>
          )}
        </div>

        {(running || failed) && (
          <div className={`study-run${failed ? ' failed' : ''}`} role="status">
            {running && progress && (
              <>
                <div className="study-progress-label">
                  <span>{progress.stage}</span>
                  <span className="muted">
                    {progress.percent}% · {formatElapsed(now - (run?.startedAt ?? now))}
                  </span>
                </div>
                <div className="study-progress" aria-hidden="true">
                  <div style={{ width: `${progress.percent}%` }} />
                </div>
              </>
            )}
            {failed && <div className="study-problem">{failed}</div>}
            {log.length > 0 && (
              <pre className="study-log">
                {log.map((l, i) => (
                  <div key={i} className={l.error ? 'study-loss' : undefined}>
                    {l.text}
                  </div>
                ))}
              </pre>
            )}
            {failed && !running && (
              <button type="button" className="btn btn-tiny" onClick={() => setFailed(null)}>
                Dismiss
              </button>
            )}
          </div>
        )}

        {comparePick && (
          <div className="study-pick-banner" role="status">
            <GitCompare size={14} />
            Pick another result under Recent results to compare with “{comparePick.name}”.
            <button type="button" className="icon-button" aria-label="Cancel comparing" onClick={() => setComparePick(null)}>
              <X size={13} />
            </button>
          </div>
        )}
        <div className="studies-body">
          {/* Kept mounted while results are shown, so the conversation survives a look at them. */}
          <div hidden={!builderShown}>
            <AssistantPanel
              current={problem ? null : normalizeSpec(current.spec)}
              onUseNew={(spec) => void openProposal(spec)}
              onUseRevision={(spec) => setCurrent((c) => ({ ...c, spec }))}
              say={toast}
            />
          </div>
          {view === 'compare' && comparing ? (
            <CompareView
              a={comparing.a}
              b={comparing.b}
              onOpen={(id) => {
                const info = runs.find((r) => r.id === id);
                if (info) void openRun(info);
              }}
              onClose={() => setView(result ? 'results' : 'build')}
            />
          ) : view === 'notebook' && openNotebook ? (
            <NotebookView
              key={openNotebook}
              notebookId={openNotebook}
              onOpenStudy={(id) => void openStudyById(id)}
              onOpenResult={(id) => {
                const info = runs.find((r) => r.id === id);
                if (info) void openRun(info);
                else toast('That result is no longer stored.', 'info');
              }}
              onCompareResult={(id) => void compareWith(id, runs.find((r) => r.id === id)?.name ?? 'this result')}
              onChanged={() => void refresh()}
              onDeleted={() => {
                setOpenNotebook(null);
                setView('build');
                void refresh();
              }}
              onClose={() => setView(result ? 'results' : 'build')}
              say={(text, kind) => toast(text, kind)}
            />
          ) : view === 'results' && result ? (
            <>
              <ResultExplainer key={result.id ?? 'unsaved'} result={result.data} say={toast} />
              <StudyResults result={result.data} onOpenEvent={onOpenEvent} onAddToWatchlist={setAdding} />
            </>
          ) : (
            <>
              {studyRuns.length > 0 && !result && (
                <div className="study-note small muted">
                  This Study has {studyRuns.length} stored result{studyRuns.length === 1 ? '' : 's'}; open one from Recent results.
                </div>
              )}
              <StudyBuilder
                draft={current.spec}
                onChange={(spec) => setCurrent((c) => ({ ...c, spec }))}
                problem={problem}
                readiness={readiness}
                onApplyFix={(fix: ReadinessFix) => setCurrent((c) => ({ ...c, spec: applyFix(normalizeSpec(c.spec), fix) }))}
                watchlists={watchlists}
              />
            </>
          )}
        </div>
      </div>

      {pythonOpen && !problem && (
        <PythonDialog spec={normalizeSpec(current.spec)} onClose={() => setPythonOpen(false)} onOpenPython={onOpenPython} say={(kind, text) => toast(text, kind)} />
      )}
      {adding && (
        <AddToWatchlistDialog symbols={adding} onClose={() => setAdding(null)} say={(level, text) => toast(text, level === 'error' ? 'error' : 'success')} />
      )}
    </div>
  );
}
