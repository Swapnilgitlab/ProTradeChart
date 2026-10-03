import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CirclePlay,
  Copy,
  FilePlus2,
  ListChecks,
  MapPin,
  PanelLeft,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useToast } from '../../components/Toasts';
import { useDismiss } from '../../components/useDismiss';
import { confirmDelete, confirmDiscard } from '../../lib/dialogs';
import {
  deleteScreener,
  errorMessage,
  exportStudyFile,
  getScreenerResult,
  listScreeners,
  listWatchlists,
  pythonEnvStatus,
  saveScreener,
  saveScreenerResult,
  type PythonEnvStatus,
  type ScreenerRow,
} from '../../lib/ipc';
import { formatElapsed } from '../../python/format';
import { chipText } from '../../screener/catalog';
import { fromPreset, PRESETS } from '../../screener/presets';
import { screenReadiness } from '../../screener/readiness';
import { parseScreenResult, screenCsv, type ScreenResult } from '../../screener/result';
import { loadFrom, normalizeScreen, outputColumns, screenProblem, type ScreenSpec } from '../../screener/spec';
import { canonicalFeature, featureLabel } from '../../studies/metrics';
import { TRIAL_SYMBOLS, type UniverseEstimate } from '../../studies/readiness';
import type { Series } from '../../studies/spec';
import { useProviderState } from '../providers/useProviderState';
import { AddToWatchlistDialog } from '../python/AddToWatchlistDialog';
import { FEATURE_CHOICES } from '../studies/ConditionList';
import { estimateUniverse } from '../studies/estimate';
import { FilterChips } from './FilterChips';
import { ScreenTable } from './ScreenTable';
import { useScreenRunner } from './useScreenRunner';

interface Props {
  /** Whether the tab is showing. Nothing is loaded until it first is. */
  visible: boolean;
  onOpenSymbol: (symbol: string) => void;
}

interface Current {
  id: string;
  spec: ScreenSpec;
  /** The spec as last saved or opened (normalised JSON): what "unsaved changes" is judged against. */
  baseline: string | null;
  isSaved: boolean;
}

const SERIES_CHOICES: [Series, string][] = [
  ['EQ', 'Ordinary shares'],
  ['BE', 'Trade-for-trade (BE)'],
  ['SME', 'SME'],
];

function fresh(presetId = 'near_high'): Current {
  const spec = fromPreset(presetId);
  return { id: crypto.randomUUID(), spec, baseline: JSON.stringify(spec), isSaved: false };
}

function savedForm(spec: unknown): string | null {
  try {
    return JSON.stringify(normalizeScreen(spec));
  } catch {
    return null;
  }
}

/** The Screener workspace: saved screens and presets on the left; the screen's filters, columns and
 *  universe above its results on the right. A screen runs only when Run is pressed. */
export function ScreenerPanel({ visible, onOpenSymbol }: Props) {
  const toast = useToast();
  const { providers } = useProviderState();
  const [screens, setScreens] = useState<ScreenerRow[]>([]);
  const [watchlistRows, setWatchlistRows] = useState<{ id: number; name: string }[]>([]);
  const watchlists = useMemo(() => watchlistRows.map((w) => w.name), [watchlistRows]);
  const [env, setEnv] = useState<PythonEnvStatus | null>(null);
  const [estimate, setEstimate] = useState<UniverseEstimate | null>(null);
  const [current, setCurrent] = useState<Current>(() => fresh());
  const [result, setResult] = useState<ScreenResult | null>(null);
  // What the engine sent for `result`, kept as it was: a screen saved after it ran stores this.
  const rawResult = useRef<unknown>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [adding, setAdding] = useState<string[] | null>(null);
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  // Filters and Columns fold while the results are shown as charts, which want the height; each
  // heading still opens its section.
  const [filtersCollapsed, setFiltersCollapsed] = useState(false);
  const [columnsCollapsed, setColumnsCollapsed] = useState(false);
  const foldForCharts = (charts: boolean) => {
    setFiltersCollapsed(charts);
    setColumnsCollapsed(charts);
  };
  // With no results there are no charts, so nothing to make room for.
  useEffect(() => {
    if (result) return;
    setFiltersCollapsed(false);
    setColumnsCollapsed(false);
  }, [result]);
  const columnMenuRef = useRef<HTMLDivElement>(null);
  useDismiss(columnMenuRef, columnMenuOpen, () => setColumnMenuOpen(false));
  const loaded = useRef(false);
  const runner = useScreenRunner();
  const { run, progress, log, now } = runner;

  const draft = current.spec;
  const problem = useMemo(() => screenProblem(draft), [draft]);
  const normal = useMemo(() => (problem ? null : normalizeScreen(draft)), [problem, draft]);
  const dirty = savedForm(draft) !== current.baseline;
  const set = (patch: Partial<ScreenSpec>) => setCurrent((c) => ({ ...c, spec: { ...c.spec, ...patch } }));
  const setUniverse = (patch: Partial<ScreenSpec['universe']>) => set({ universe: { ...draft.universe, ...patch } });

  const refresh = useCallback(async () => {
    try {
      setScreens(await listScreeners());
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

  // What the universe will cost to load, re-read as it changes (after a pause in typing).
  const estimateKey = useMemo(() => (normal ? JSON.stringify({ universe: normal.universe, from: loadFrom(normal, new Date()) }) : null), [normal]);
  useEffect(() => {
    if (!visible || !estimateKey) {
      setEstimate(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const { universe, from } = JSON.parse(estimateKey) as { universe: ScreenSpec['universe']; from: string };
        const next = await estimateUniverse(universe, from, watchlistRows);
        if (!cancelled) setEstimate(next);
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

  const readiness = useMemo(
    () =>
      normal &&
      screenReadiness(normal, {
        providers: providers.map((p) => ({ id: p.id, usable: p.enabled && p.configured })),
        pythonReady: env?.state === 'ready',
        pythonMessage: env?.message ?? 'Looking for Python…',
        watchlists,
        estimate,
      }),
    [normal, providers, env, watchlists, estimate],
  );

  // ---- Actions ---------------------------------------------------------------------------

  const canLeave = useCallback(async () => {
    if (!dirty) return true;
    return confirmDiscard(`"${draft.name}" has changes that aren’t saved. Discard them?`);
  }, [dirty, draft.name]);

  const startRun = () => {
    if (run || !normal || !readiness?.ready) return;
    setFailed(null);
    const id = current.id;
    runner.start(
      normal,
      (data, raw) => {
        setResult(data);
        rawResult.current = raw;
        // Kept as the screen's last run when the screen is saved; otherwise it is only shown.
        saveScreenerResult(id, JSON.stringify(raw), data.meta.executedAt)
          .then((kept) => kept && void refresh())
          .catch((err) => toast(`The results are shown but couldn’t be kept: ${errorMessage(err)}`, 'error'));
      },
      (error) => setFailed(error),
    );
  };

  const save = async () => {
    if (!normal) {
      toast(`Can’t save yet: ${problem}`, 'error');
      return;
    }
    const json = JSON.stringify(normal);
    try {
      await saveScreener(current.id, normal.name, json);
      // A run made before the first save is kept with it, if it ran this very screen.
      if (!current.isSaved && result && JSON.stringify(result.spec) === json) {
        await saveScreenerResult(current.id, JSON.stringify(rawResult.current), result.meta.executedAt);
      }
      setCurrent((c) => ({ ...c, spec: normal, baseline: json, isSaved: true }));
      await refresh();
      toast(`Saved “${normal.name}”.`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const openScreen = async (row: ScreenerRow) => {
    if (row.id === current.id || !(await canLeave())) return;
    try {
      const spec = normalizeScreen(JSON.parse(row.specJson));
      setCurrent({ id: row.id, spec, baseline: JSON.stringify(spec), isSaved: true });
      setFailed(null);
      setResult(null);
      const stored = await getScreenerResult(row.id);
      rawResult.current = stored ? JSON.parse(stored) : null;
      setResult(stored ? parseScreenResult(rawResult.current) : null);
    } catch (err) {
      toast(`“${row.name}” couldn’t be opened: ${errorMessage(err)}`, 'error');
    }
  };

  const openPreset = async (id: string) => {
    if (!(await canLeave())) return;
    setCurrent(fresh(id));
    setResult(null);
    setFailed(null);
  };

  const duplicate = () => {
    setCurrent((c) => ({ id: crypto.randomUUID(), spec: { ...structuredClone(c.spec), name: `${c.spec.name} (copy)`.slice(0, 120) }, baseline: null, isSaved: false }));
  };

  const remove = async (row: ScreenerRow) => {
    if (!(await confirmDelete(`Delete the screen “${row.name}”?`))) return;
    try {
      await deleteScreener(row.id);
      if (row.id === current.id) setCurrent((c) => ({ ...c, baseline: null, isSaved: false }));
      await refresh();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const exportCsv = async (rows: ScreenResult['rows']) => {
    if (!result) return;
    try {
      const path = await exportStudyFile(`${result.spec.name} ${result.meta.asOf}`, 'csv', screenCsv(result, rows));
      if (path) toast(`Saved ${path}`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const addColumn = (key: string) => {
    if (!draft.columns.includes(key)) set({ columns: [...draft.columns, key] });
  };

  const removeColumn = (name: string) => {
    const columns = draft.columns.filter((c) => c !== name);
    // A sort on a column that's gone would make the screen invalid; fall back to no sort.
    const sortStays = draft.sort && outputColumns({ columns, filters: draft.filters }).includes(draft.sort.column);
    set({ columns, sort: sortStays ? draft.sort : null });
  };

  const running = run !== null;
  const canRun = !!normal && !!readiness?.ready && !running;
  const blockingCheck = readiness?.checks.find((c) => c.blocking)?.text;
  const runTitle = problem ?? blockingCheck ?? 'Run the screen';
  const availableColumns = FEATURE_CHOICES.filter((f) => !draft.columns.includes(f));
  // The columns a sort can use: those the result will have, spelled correctly.
  const sortChoices = outputColumns({ columns: draft.columns, filters: draft.filters.filter((f) => canonicalFeature(f.left)) })
    .map((c) => canonicalFeature(c))
    .filter((c): c is string => !!c)
    .filter((c, i, all) => all.indexOf(c) === i);
  const resultIsStale = result && normal && JSON.stringify(result.spec) !== JSON.stringify(normal);

  return (
    <div className={`studies-panel screener-panel${sideCollapsed ? ' side-collapsed' : ''}`}>
      <aside className={`python-side studies-side${sideCollapsed ? ' screener-side-collapsed' : ''}`} aria-label="Screens">
        <div className="python-side-header">
          {!sideCollapsed && <span>My screens</span>}
          <span className="screener-side-header-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={sideCollapsed ? 'Show my screens' : 'Collapse my screens'}
              title={sideCollapsed ? 'Show my screens' : 'Collapse'}
              onClick={() => setSideCollapsed((v) => !v)}
            >
              {sideCollapsed ? <PanelLeft size={14} /> : <PanelLeftClose size={14} />}
            </button>
            {!sideCollapsed && (
              <button type="button" className="icon-button" aria-label="New screen" title="New screen" onClick={() => void openPreset('custom')}>
                <FilePlus2 size={14} />
              </button>
            )}
          </span>
        </div>
        {!sideCollapsed && (
          <div className="python-side-list studies-side-list">
            {screens.length === 0 && <div className="python-side-empty small muted">No saved screens yet. Start from a preset below.</div>}
            {screens.map((s) => (
              <div key={s.id} className={`python-script${s.id === current.id ? ' active' : ''}`}>
                <button type="button" className="python-script-name studies-run" title={s.name} onClick={() => void openScreen(s)}>
                  <span>{s.name}</span>
                  <span className="muted small">{s.ranAt ? `Ran ${s.ranAt.slice(0, 16).replace('T', ' ')}` : 'Not run yet'}</span>
                </button>
                <button type="button" className="icon-button" aria-label={`Delete ${s.name}`} title="Delete" onClick={() => void remove(s)}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <div className="python-side-header studies-subhead">Presets</div>
            {PRESETS.filter((p) => p.id !== 'custom').map((p) => (
              <div key={p.id} className="python-script">
                <button type="button" className="python-script-name" title={p.summary} onClick={() => void openPreset(p.id)}>
                  {p.name}
                </button>
              </div>
            ))}
          </div>
        )}
      </aside>

      <div className="python-main">
        <div className="pine-toolbar">
          <label className="screener-name-picker" title={draft.name}>
            <select
              className="screener-name-select"
              value={current.isSaved ? current.id : '__draft__'}
              onChange={(e) => {
                if (e.currentTarget.value === '__draft__') return;
                const row = screens.find((s) => s.id === e.currentTarget.value);
                if (row) void openScreen(row);
              }}
              aria-label="Switch screen"
            >
              {!current.isSaved && <option value="__draft__">{draft.name || 'Untitled screen'}</option>}
              {screens.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
          <span className={`pine-status${dirty ? ' dirty' : ''}`}>{!current.isSaved ? 'Not saved' : dirty ? 'Unsaved changes' : 'Saved'}</span>
          <div className="pine-toolbar-spacer" />
          <button type="button" className="icon-button" aria-label="Refresh" title="Run the screen again" onClick={startRun} disabled={!canRun}>
            <RefreshCw size={15} />
          </button>
          <button type="button" className="btn pine-btn" onClick={duplicate} title="Duplicate as a new screen">
            <Copy size={14} />
            Duplicate
          </button>
          <button type="button" className="btn pine-btn" onClick={() => void save()} disabled={!dirty && current.isSaved} title="Save the screen">
            <Save size={14} />
            Save
          </button>
          {running ? (
            <button type="button" className="btn pine-btn python-stop" onClick={runner.stop}>
              <Square size={13} />
              Stop
            </button>
          ) : (
            <button type="button" className="btn btn-primary pine-btn" onClick={startRun} disabled={!canRun} title={runTitle}>
              <CirclePlay size={14} />
              {result ? 'Run again' : 'Run'}
            </button>
          )}
        </div>

        <div className="screener-quickbar" aria-label="Quick universe filters">
          <label className="screener-chip screener-chip-select" title="Which stocks the screen looks at">
            <ListChecks size={13} aria-hidden="true" />
            <select value={draft.universe.source} onChange={(e) => setUniverse({ source: e.currentTarget.value as ScreenSpec['universe']['source'] })}>
              <option value="instruments">Broker instruments</option>
              <option value="watchlist">Watchlist</option>
              <option value="symbols">Symbol list</option>
            </select>
            <ChevronDown size={12} aria-hidden="true" />
          </label>
          {draft.universe.source === 'watchlist' && (
            <label className="screener-chip screener-chip-select">
              <select value={draft.universe.watchlist ?? ''} onChange={(e) => setUniverse({ watchlist: e.currentTarget.value || null })}>
                <option value="">Choose a watchlist…</option>
                {watchlists.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </label>
          )}
          {draft.universe.source === 'instruments' && (
            <span className="screener-chip screener-chip-static">
              <MapPin size={13} aria-hidden="true" />
              {(['NSE', 'BSE'] as const).map((ex) => (
                <button
                  type="button"
                  key={ex}
                  className={`screener-exchange${draft.universe.exchanges.includes(ex) ? ' on' : ''}`}
                  aria-pressed={draft.universe.exchanges.includes(ex)}
                  onClick={() =>
                    setUniverse({
                      exchanges: draft.universe.exchanges.includes(ex)
                        ? draft.universe.exchanges.filter((x) => x !== ex)
                        : [...draft.universe.exchanges, ex],
                    })
                  }
                >
                  {ex}
                </button>
              ))}
            </span>
          )}
          <button
            type="button"
            className={`screener-chip screener-more-toggle${moreOpen ? ' on' : ''}`}
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            title="Rename, pick a broker, cap the symbol count, include BE/SME, list symbols by hand, or see what the run will cost"
          >
            <SlidersHorizontal size={13} aria-hidden="true" />
            More options
            {!moreOpen && blockingCheck && <span className="screener-more-dot" aria-hidden="true" title={blockingCheck} />}
            {moreOpen ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
          </button>
        </div>

        {moreOpen && (
          <div className="screener-more-panel">
            <div className="study-form">
              <section className="study-section">
                <h3>Screen</h3>
                <label className="study-field">
                  <span>Name</span>
                  <input className="python-input" value={draft.name} maxLength={120} onChange={(e) => set({ name: e.currentTarget.value })} />
                </label>
              </section>
              <section className="study-section">
                <h3>Universe</h3>
                <div className="study-row">
                  <label className="study-field">
                    <span>From</span>
                    <select className="python-input" value={draft.universe.source} onChange={(e) => setUniverse({ source: e.currentTarget.value as ScreenSpec['universe']['source'] })}>
                      <option value="instruments">Broker instrument list</option>
                      <option value="watchlist">A watchlist</option>
                      <option value="symbols">Symbols I list</option>
                    </select>
                  </label>
                  {draft.universe.source === 'instruments' && (
                    <label className="study-field">
                      <span>Broker</span>
                      <select className="python-input" value={draft.universe.provider} onChange={(e) => setUniverse({ provider: e.currentTarget.value as 'zerodha' })}>
                        <option value="zerodha">Zerodha</option>
                                              </select>
                    </label>
                  )}
                  {draft.universe.source === 'watchlist' && (
                    <label className="study-field">
                      <span>Watchlist</span>
                      <select className="python-input" value={draft.universe.watchlist ?? ''} onChange={(e) => setUniverse({ watchlist: e.currentTarget.value || null })}>
                        <option value="">Choose…</option>
                        {watchlists.map((w) => (
                          <option key={w} value={w}>
                            {w}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                {draft.universe.source === 'instruments' && (
                  <div className="study-row">
                    <fieldset className="study-field study-checks">
                      <legend>Exchanges</legend>
                      {(['NSE', 'BSE'] as const).map((ex) => (
                        <label key={ex}>
                          <input
                            type="checkbox"
                            checked={draft.universe.exchanges.includes(ex)}
                            onChange={(e) =>
                              setUniverse({ exchanges: e.currentTarget.checked ? [...draft.universe.exchanges, ex] : draft.universe.exchanges.filter((x) => x !== ex) })
                            }
                          />
                          {ex}
                        </label>
                      ))}
                    </fieldset>
                    <fieldset className="study-field study-checks" title="Bonds, SGBs, G-secs, T-bills and funds are always left out">
                      <legend>Listings</legend>
                      {SERIES_CHOICES.map(([id, label]) => (
                        <label key={id}>
                          <input
                            type="checkbox"
                            checked={draft.universe.series.includes(id)}
                            onChange={(e) =>
                              setUniverse({ series: e.currentTarget.checked ? [...draft.universe.series, id] : draft.universe.series.filter((x) => x !== id) })
                            }
                          />
                          {label}
                        </label>
                      ))}
                    </fieldset>
                  </div>
                )}
                {draft.universe.source === 'symbols' && (
                  <label className="study-field">
                    <span>Symbols, one per line (zerodha:NSE:RELIANCE)</span>
                    <textarea
                      className="python-input study-textarea"
                      rows={4}
                      spellCheck={false}
                      value={draft.universe.symbols.join('\n')}
                      onChange={(e) => setUniverse({ symbols: e.currentTarget.value.split(/\s+/).filter(Boolean) })}
                    />
                  </label>
                )}
                <label className="study-field">
                  <span>Only the first N symbols</span>
                  <input
                    className="python-input"
                    type="number"
                    min={1}
                    placeholder="All"
                    value={draft.universe.max_symbols ?? ''}
                    onChange={(e) => setUniverse({ max_symbols: e.currentTarget.value === '' ? null : e.currentTarget.valueAsNumber })}
                  />
                </label>
              </section>

              <section className="study-section" aria-live="polite">
                <h3>Before it runs</h3>
                {problem ? (
                  <p className="study-problem small">{problem}</p>
                ) : (
                  <ul className="screener-checks">
                    {readiness?.checks.map((c, i) => (
                      <li key={i} className={c.ok ? undefined : c.blocking ? 'study-loss' : 'study-warn'}>
                        {c.ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                        {c.text}
                      </li>
                    ))}
                  </ul>
                )}
                {readiness?.offerTrial && (
                  <button type="button" className="btn btn-tiny" onClick={() => setUniverse({ max_symbols: TRIAL_SYMBOLS })}>
                    Try it on the first {TRIAL_SYMBOLS} symbols first
                  </button>
                )}
                <p className="muted small">
                  Bars are the broker’s daily bars. With Market data downloaded (Data providers), every NSE stock is read from this computer in one go; anything else is fetched at the broker’s pace and kept, so later runs are quick.
                </p>
              </section>
            </div>
          </div>
        )}

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

        <div className="studies-body">
          <div className="study-builder screener-builder">
            <div className="study-form">
              <section className="study-section">
                <h3>
                  <SectionToggle title="Filters" collapsed={filtersCollapsed} onToggle={() => setFiltersCollapsed((v) => !v)} />
                  {filtersCollapsed && (
                    <span className="muted small screener-section-summary">
                      {draft.filters.length === 0 ? 'None: every stock is listed' : draft.filters.map(chipText).join(' · ')}
                    </span>
                  )}
                </h3>
                {!filtersCollapsed && (
                  <>
                    <p className="muted small study-hint">
                      A stock matches when all of these hold on its latest bar. “Crosses above” means it crossed on that bar. With no filters, every stock is listed.
                    </p>
                    <FilterChips items={draft.filters} onChange={(filters) => set({ filters })} />
                  </>
                )}
              </section>

              <section className="study-section">
                <h3>
                  <SectionToggle title="Columns" collapsed={columnsCollapsed} onToggle={() => setColumnsCollapsed((v) => !v)} />
                  {columnsCollapsed && (
                    <span className="muted small screener-section-summary">
                      {draft.columns.length === 0 ? 'None' : draft.columns.map(featureLabel).join(', ')}
                      {draft.sort ? ` · ordered by ${featureLabel(draft.sort.column)}` : ''}
                    </span>
                  )}
                </h3>
                {!columnsCollapsed && (
                  <>
                    <p className="muted small study-hint">Shown for every match, after the symbol. The features the filters read are shown too.</p>
                    <div className="screener-columns">
                      {draft.columns.map((c) => (
                        <span key={c} className={`screener-chip${canonicalFeature(c) ? '' : ' invalid'}`} title={c}>
                          {featureLabel(c)}
                          <button type="button" className="icon-button" aria-label={`Remove ${featureLabel(c)}`} onClick={() => removeColumn(c)}>
                            <X size={11} />
                          </button>
                        </span>
                      ))}
                      <div className="menu-anchor" ref={columnMenuRef}>
                        <button
                          type="button"
                          className="icon-button screener-add-column-btn"
                          aria-label="Add a column"
                          aria-haspopup="menu"
                          aria-expanded={columnMenuOpen}
                          onClick={() => setColumnMenuOpen((v) => !v)}
                        >
                          <Plus size={14} />
                        </button>
                        {columnMenuOpen && (
                          <div className="menu left" role="menu">
                            {availableColumns.length === 0 && <div className="menu-empty small">Every feature is already a column.</div>}
                            {availableColumns.map((f) => (
                              <button
                                key={f}
                                type="button"
                                role="menuitem"
                                className="menu-item"
                                onClick={() => addColumn(f)}
                              >
                                <span className="grow">{featureLabel(f)}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="study-row">
                      <label className="study-field">
                        <span>Order by</span>
                        <select
                          className="python-input"
                          value={draft.sort?.column ?? ''}
                          onChange={(e) => set({ sort: e.currentTarget.value ? { column: e.currentTarget.value, descending: draft.sort?.descending ?? true } : null })}
                        >
                          <option value="">Symbol (A–Z)</option>
                          {sortChoices.map((c) => (
                            <option key={c} value={c}>
                              {featureLabel(c)}
                            </option>
                          ))}
                        </select>
                      </label>
                      {draft.sort && (
                        <label className="study-field">
                          <span>Direction</span>
                          <select
                            className="python-input"
                            value={draft.sort.descending ? 'desc' : 'asc'}
                            onChange={(e) => set({ sort: draft.sort && { ...draft.sort, descending: e.currentTarget.value === 'desc' } })}
                          >
                            <option value="desc">Highest first</option>
                            <option value="asc">Lowest first</option>
                          </select>
                        </label>
                      )}
                    </div>
                  </>
                )}
              </section>
            </div>
          </div>

          <div className="screener-results-wrap">
            {result ? (
              <>
                {resultIsStale && <div className="study-note small muted">The screen has changed since these results; run it again to see the new ones.</div>}
                {result.warnings.length > 0 && (
                  <ul className="screener-warnings small muted">
                    {result.warnings.map((w) => (
                      <li key={w.code}>{w.message}</li>
                    ))}
                  </ul>
                )}
                <ScreenTable
                  result={result}
                  onOpenSymbol={onOpenSymbol}
                  onAddToWatchlist={setAdding}
                  onExport={(rows) => void exportCsv(rows)}
                  onViewChange={(view) => foldForCharts(view === 'charts')}
                />
              </>
            ) : (
              !running && <p className="muted small screener-empty">Press Run to see which stocks match today.</p>
            )}
          </div>
        </div>
      </div>

      {adding && <AddToWatchlistDialog symbols={adding} onClose={() => setAdding(null)} say={(level, text) => toast(text, level === 'error' ? 'error' : 'success')} />}
    </div>
  );
}

/** A builder section's heading as a button that folds the section. */
function SectionToggle({ title, collapsed, onToggle }: { title: string; collapsed: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="screener-section-toggle" aria-expanded={!collapsed} onClick={onToggle}>
      {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      {title}
    </button>
  );
}
