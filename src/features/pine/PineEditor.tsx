import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, CirclePlay, FolderOpen, RefreshCw, Save, Trash2, Eraser } from 'lucide-react';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { useToast } from '../../components/Toasts';
import { useDismiss } from '../../components/useDismiss';
import { confirmDelete, confirmDiscard } from '../../lib/dialogs';
import { getPreference, setPreference, type PineScriptRow } from '../../lib/ipc';
import { BUNDLED_SCRIPTS, type BundledScript } from '../../pine/bundled';
import type { DockRequest } from '../../pine/dockBus';
import { makeIndicatorId, scriptIdOf } from '../../pine/engine';
import { TEMPLATES, declaredTitle, detectKind, type ScriptTemplate } from '../../pine/source';
import { CodeEditor } from './CodeEditor';
import { useActiveChart, useIndicatorTick } from './useActiveChart';
import { usePineScripts } from './usePineScripts';

const PREF_DRAFT = 'pine_draft';
const MAX_CONSOLE_LINES = 200;

interface Buffer {
  id: string;
  name: string;
  source: string;
  /** The chart indicator "Update on chart" targets, once this script has been added. */
  linkedIndicatorId: string | null;
}

type Level = 'info' | 'warn' | 'error';

interface ConsoleLine {
  n: number;
  level: Level;
  text: string;
  at: Date;
}

type EditRequest = Extract<DockRequest, { type: 'edit-indicator' }>;

interface Props {
  workspace: VelaWorkspace | null;
  /** A legend "Edit script" click; a new object each time so the same row can be reopened. */
  editRequest: EditRequest | null;
  /** A strategy was just added, so the tester is what to look at next. */
  onStrategyAdded: () => void;
}

const fromTemplate = (t: ScriptTemplate): Buffer => ({
  id: crypto.randomUUID(),
  name: declaredTitle(t.source) ?? t.label,
  source: t.source,
  linkedIndicatorId: null,
});

const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function PineEditor({ workspace, editRequest, onStrategyAdded }: Props) {
  const toast = useToast();
  const { scripts, save, remove } = usePineScripts();
  const chart = useActiveChart(workspace);
  const indicatorTick = useIndicatorTick(chart);

  const [buffer, setBuffer] = useState<Buffer>(() => fromTemplate(TEMPLATES[0]));
  const [editorKey, setEditorKey] = useState(0);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const lineCounter = useRef(1);
  const touched = useRef(false);
  const seenWarnings = useRef(new Set<string>());
  useDismiss(menuRef, menuOpen, () => setMenuOpen(false));

  const log = useCallback((level: Level, text: string) => {
    setLines((prev) => [...prev.slice(-(MAX_CONSOLE_LINES - 1)), { n: lineCounter.current++, level, text, at: new Date() }]);
  }, []);

  const saved = scripts.find((s) => s.id === buffer.id);
  const dirty = !saved || saved.source !== buffer.source || saved.name !== buffer.name;
  const kind = useMemo(() => detectKind(buffer.source), [buffer.source]);

  // The chart indicator this script is running as, if any — found by the id we minted for
  // it, so it is still found after the script is reopened from the library.
  // `indicatorTick` is read so adds and removals re-evaluate this.
  void indicatorTick;
  const linked =
    chart?.indicators().find((h) => h.id === buffer.linkedIndicatorId) ??
    chart?.indicators().find((h) => scriptIdOf(h.id) === buffer.id) ??
    null;

  // Bring back the unsaved draft from the last session, unless the user has already typed.
  useEffect(() => {
    let cancelled = false;
    getPreference(PREF_DRAFT)
      .then((raw) => {
        if (cancelled || touched.current || !raw) return;
        const d = JSON.parse(raw) as Partial<Buffer>;
        if (typeof d.id === 'string' && typeof d.name === 'string' && typeof d.source === 'string') {
          setBuffer({ id: d.id, name: d.name, source: d.source, linkedIndicatorId: null });
          setEditorKey((k) => k + 1);
        }
      })
      .catch(() => {}); // a missing or corrupt draft just means starting from the template
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the working copy across restarts. Debounced: it changes on every keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPreference(PREF_DRAFT, JSON.stringify({ id: buffer.id, name: buffer.name, source: buffer.source })).catch(() => {});
    }, 700);
    return () => window.clearTimeout(timer);
  }, [buffer.id, buffer.name, buffer.source]);

  // Errors a script raises after it is on the chart (a bad input, a runtime failure).
  useEffect(() => {
    if (!chart) return;
    return chart.on('indicator:error', ({ id, error }) => {
      // A handle's own title is a placeholder; the script's declared title is what the legend shows.
      const handle = chart.indicators().find((h) => h.id === id);
      const title = (handle?.source && declaredTitle(handle.source)) || handle?.title || 'Script';
      log('error', `${title}: ${error.message}`);
    });
  }, [chart, log]);

  // Warnings from any running script, once each (a script warns again on every bar).
  useEffect(() => {
    if (!workspace) return;
    return workspace.on('script:run', (run) => {
      for (const w of run.warnings) {
        const key = `${run.id}|${w.message}`;
        if (seenWarnings.current.has(key)) continue;
        seenWarnings.current.add(key);
        log('warn', `${run.title}: ${w.message}${w.method ? ` (${w.method})` : ''}`);
      }
    });
  }, [workspace, log]);

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
  }, [lines]);

  const load = useCallback((next: Buffer) => {
    touched.current = true;
    setBuffer(next);
    setEditorKey((k) => k + 1);
  }, []);

  /** Asks before unsaved work is replaced; true means go ahead. */
  const canReplace = useCallback(async () => {
    if (!dirty || buffer.source.trim() === '') return true;
    return confirmDiscard(`"${buffer.name || 'Untitled script'}" has unsaved changes. Discard them?`);
  }, [dirty, buffer.name, buffer.source]);

  const openTemplate = useCallback(
    async (t: ScriptTemplate) => {
      setMenuOpen(false);
      if (await canReplace()) load(fromTemplate(t));
    },
    [canReplace, load],
  );

  const openBundled = useCallback(
    async (script: BundledScript) => {
      setMenuOpen(false);
      // A copy: saving it adds to the user's library and never touches the shipped file.
      if (await canReplace()) load({ id: crypto.randomUUID(), name: script.name, source: script.source, linkedIndicatorId: null });
    },
    [canReplace, load],
  );

  const openSaved = useCallback(
    async (row: PineScriptRow) => {
      setMenuOpen(false);
      if (row.id === buffer.id && !dirty) return;
      if (await canReplace()) load({ id: row.id, name: row.name, source: row.source, linkedIndicatorId: null });
    },
    [buffer.id, dirty, canReplace, load],
  );

  // "Edit script" on a legend row: show the code behind that row.
  const handledRequest = useRef<EditRequest | null>(null);
  useEffect(() => {
    if (!editRequest || handledRequest.current === editRequest) return;
    handledRequest.current = editRequest;
    (async () => {
      const libraryId = scriptIdOf(editRequest.indicatorId);
      const alreadyOpen = libraryId === buffer.id || editRequest.indicatorId === buffer.linkedIndicatorId;
      if (!alreadyOpen && !(await canReplace())) return;
      load({
        id: libraryId ?? crypto.randomUUID(),
        name: scripts.find((s) => s.id === libraryId)?.name ?? declaredTitle(editRequest.source) ?? editRequest.name,
        source: editRequest.source,
        linkedIndicatorId: editRequest.indicatorId,
      });
      // An id we didn't mint means Vela added it: a script bundled with the app. Edits show
      // on this chart, but a saved layout stores only its name, so they aren't kept.
      if (libraryId === null) {
        log('info', `"${declaredTitle(editRequest.source) ?? editRequest.name}" is bundled with the app. Edits apply to this chart only; Save keeps your own copy in My scripts.`);
      }
    })();
  }, [editRequest, buffer.id, buffer.linkedIndicatorId, canReplace, load, scripts, log]);

  const saveScript = useCallback(async () => {
    if (!kind) {
      log('error', 'Nothing to save yet: start the script with indicator(…) or strategy(…).');
      return false;
    }
    const name = buffer.name.trim() || declaredTitle(buffer.source) || 'Untitled script';
    if (!(await save({ id: buffer.id, name, kind, source: buffer.source }))) return false;
    setBuffer((b) => (b.id === buffer.id ? { ...b, name } : b));
    log('info', `Saved "${name}".`);
    return true;
  }, [kind, buffer.id, buffer.name, buffer.source, save, log]);

  const runOnChart = useCallback(async () => {
    if (!workspace || !chart) {
      log('error', 'No chart is ready yet.');
      return;
    }
    if (!kind) {
      log(
        'error',
        /^\s*library\s*\(/m.test(buffer.source) ? "A library() script can't be added to a chart." : 'Start the script with indicator(…) or strategy(…).',
      );
      return;
    }
    if (linked) {
      // Replaces the code in place: same legend row, pane and settings. A script that
      // doesn't compile leaves the running one untouched; the error listener above logs it.
      // Success is the script's next run, tagged `code` (the handle's own `ready` fires once).
      const id = linked.id;
      const stops: (() => void)[] = [];
      const done = () => stops.forEach((stop) => stop());
      stops.push(
        chart.on('script:run', (run) => {
          if (run.id !== id || run.cause !== 'code') return;
          log('info', `Updated "${run.title}" on the chart.`);
          done();
        }),
      );
      stops.push(chart.on('indicator:error', (e) => e.id === id && done()));
      window.setTimeout(done, 15_000);
      linked.updateCode(buffer.source);
      return;
    }
    const id = makeIndicatorId(buffer.id);
    const result = await chart.runScript(buffer.source, { id });
    if (!result.ok) {
      log('error', result.error?.message ?? 'The script failed to run.');
      return;
    }
    setBuffer((b) => ({ ...b, linkedIndicatorId: id }));
    log('info', `Added "${result.run?.title ?? buffer.name}" to the chart.`);
    if (result.run?.kind === 'strategy') onStrategyAdded();
  }, [workspace, chart, kind, linked, buffer.id, buffer.name, buffer.source, log, onStrategyAdded]);

  const deleteSaved = useCallback(
    async (row: PineScriptRow) => {
      if (!(await confirmDelete(`Delete the script "${row.name}"? Copies already on a chart keep working.`))) return;
      if (await remove(row.id)) toast(`Deleted “${row.name}”.`, 'info');
    },
    [remove, toast],
  );

  const runLabel = linked ? 'Update on chart' : 'Add to chart';

  return (
    <div className="pine-editor">
      <div className="pine-toolbar">
        <input
          className="pine-name"
          value={buffer.name}
          placeholder="Untitled script"
          aria-label="Script name"
          onChange={(e) => {
            touched.current = true;
            setBuffer((b) => ({ ...b, name: e.currentTarget.value }));
          }}
        />
        {kind && <span className={`pine-kind ${kind}`}>{kind === 'strategy' ? 'Strategy' : 'Indicator'}</span>}
        <span className={`pine-status${dirty ? ' dirty' : ''}`}>{dirty ? 'Unsaved changes' : 'Saved'}</span>

        <div className="pine-toolbar-spacer" />

        <div className="menu-anchor" ref={menuRef}>
          <button type="button" className="menu-trigger" onClick={() => setMenuOpen((v) => !v)} aria-haspopup="menu" aria-expanded={menuOpen}>
            <FolderOpen size={14} />
            <span>Open</span>
            <ChevronDown size={14} />
          </button>
          {menuOpen && (
            <div className="menu up left pine-menu" role="menu">
              <div className="menu-heading">My scripts</div>
              {scripts.length === 0 && <div className="menu-empty small">Nothing saved yet. Write a script and press Ctrl+S.</div>}
              {scripts.map((s) => (
                <div key={s.id} className={`menu-row${s.id === buffer.id ? ' active' : ''}`}>
                  <button type="button" role="menuitem" className="menu-item" onClick={() => void openSaved(s)}>
                    <span className={`pine-kind-dot ${s.kind}`} aria-hidden="true" />
                    <span className="grow">{s.name}</span>
                    <span className="muted small">{s.kind === 'strategy' ? 'Strategy' : 'Indicator'}</span>
                  </button>
                  <button type="button" className="icon-button" aria-label={`Delete ${s.name}`} onClick={() => void deleteSaved(s)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <div className="menu-divider" />
              {BUNDLED_SCRIPTS.length > 0 && (
                <>
                  <div className="menu-heading">Bundled with the app</div>
                  {BUNDLED_SCRIPTS.map((s) => (
                    <button key={s.file} type="button" role="menuitem" className="menu-item" onClick={() => void openBundled(s)}>
                      <span className={`pine-kind-dot ${s.kind}`} aria-hidden="true" />
                      <span className="grow">{s.name}</span>
                      <span className="muted small">{s.category}</span>
                    </button>
                  ))}
                  <div className="menu-divider" />
                </>
              )}
              <div className="menu-heading">New from an example</div>
              {TEMPLATES.map((t) => (
                <button key={t.id} type="button" role="menuitem" className="menu-item" onClick={() => void openTemplate(t)}>
                  <span className={`pine-kind-dot ${t.kind}`} aria-hidden="true" />
                  <span className="grow">{t.label}</span>
                  <span className="muted small">{t.kind === 'strategy' ? 'Strategy' : 'Indicator'}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button type="button" className="btn pine-btn" onClick={() => void saveScript()} disabled={!dirty} title="Save script (Ctrl+S)">
          <Save size={14} />
          Save
        </button>
        <button type="button" className="btn btn-primary pine-btn" onClick={() => void runOnChart()} title={`${runLabel} (Ctrl+Enter)`}>
          {linked ? <RefreshCw size={14} /> : <CirclePlay size={14} />}
          {runLabel}
        </button>
      </div>

      <CodeEditor
        key={editorKey}
        value={buffer.source}
        onChange={(source) => {
          touched.current = true;
          setBuffer((b) => ({ ...b, source }));
        }}
        onSave={() => void saveScript()}
        onRun={() => void runOnChart()}
      />

      <div className="pine-console">
        <div className="pine-console-header">
          <span>Console</span>
          <button type="button" className="icon-button" aria-label="Clear console" title="Clear console" onClick={() => setLines([])} disabled={lines.length === 0}>
            <Eraser size={13} />
          </button>
        </div>
        <div className="pine-console-lines" ref={consoleRef} role="log" aria-live="polite">
          {lines.length === 0 && <div className="pine-console-empty">Compile errors and warnings from your scripts show up here.</div>}
          {lines.map((l) => (
            <div key={l.n} className={`pine-console-line ${l.level}`}>
              <span className="pine-console-time">{time(l.at)}</span>
              <span>{l.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
