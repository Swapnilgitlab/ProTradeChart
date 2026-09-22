import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { getPreference, setPreference } from '../../lib/ipc';
import { subscribeDockRequests, type DockRequest } from '../../pine/dockBus';
import { PineEditor } from './PineEditor';
import { StrategyTester } from './StrategyTester';
import { useStrategyReports } from './useStrategyReports';

type Tab = 'editor' | 'tester';

const PREF_DOCK = 'pine_dock';
const MIN_HEIGHT = 200;

/** Tall enough for the tester's KPIs and equity curve, without taking over a small window. */
function defaultHeight(): number {
  return Math.min(Math.max(Math.round(window.innerHeight * 0.46), 360), 520);
}

interface DockPrefs {
  open: boolean;
  tab: Tab;
  height: number;
}

type EditRequest = Extract<DockRequest, { type: 'edit-indicator' }>;

interface Props {
  /** The active tab's workspace; null until its chart has been built. */
  workspace: VelaWorkspace | null;
}

/** TradingView's bottom panel: the Script Editor and the Strategy Tester, sharing one
 *  resizable dock under the charts. Both stay mounted while the dock is hidden, so an
 *  editor buffer and the latest backtest survive closing and reopening it. */
export function PineDock({ workspace }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('editor');
  const [height, setHeight] = useState(defaultHeight);
  const [editRequest, setEditRequest] = useState<EditRequest | null>(null);
  const restored = useRef(false);
  // Reports are gathered whether or not the tester is showing: a strategy only announces
  // itself when it runs, so a listener that started late would never see it.
  const entries = useStrategyReports(workspace, open && tab === 'tester');

  useEffect(() => {
    getPreference(PREF_DOCK)
      .then((raw) => {
        if (!raw) return;
        const p = JSON.parse(raw) as Partial<DockPrefs>;
        if (p.tab === 'editor' || p.tab === 'tester') setTab(p.tab);
        if (typeof p.height === 'number' && p.height >= MIN_HEIGHT) setHeight(p.height);
        if (typeof p.open === 'boolean') setOpen(p.open);
      })
      .catch(() => {}) // a missing or corrupt preference just means the defaults
      .finally(() => {
        restored.current = true;
      });
  }, []);

  useEffect(() => {
    if (!restored.current) return;
    setPreference(PREF_DOCK, JSON.stringify({ open, tab, height } satisfies DockPrefs)).catch(() => {});
  }, [open, tab, height]);

  useEffect(
    () =>
      subscribeDockRequests((request) => {
        if (request.type === 'toggle') {
          setOpen((o) => !o);
        } else if (request.type === 'open-tester') {
          setTab('tester');
          setOpen(true);
        } else {
          setTab('editor');
          setOpen(true);
          setEditRequest(request);
        }
      }),
    [],
  );

  // Ctrl/Cmd+E, like the other app-wide shortcuts: modifier combos only, so it never
  // collides with Vela's letter shortcuts on the chart.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = height;
      const maxHeight = Math.round(window.innerHeight * 0.75);
      const onMove = (ev: PointerEvent) => setHeight(Math.min(Math.max(startHeight + (startY - ev.clientY), MIN_HEIGHT), maxHeight));
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [height],
  );

  return (
    <section className="pine-dock" hidden={!open} style={{ height }} aria-label="Pine Script">
      <div className="pine-resize" role="separator" aria-orientation="horizontal" aria-label="Resize panel" onPointerDown={startResize} />
      <div className="pine-dock-header">
        <div className="pine-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'editor'} className={`pine-tab${tab === 'editor' ? ' active' : ''}`} onClick={() => setTab('editor')}>
            Script Editor
          </button>
          <button type="button" role="tab" aria-selected={tab === 'tester'} className={`pine-tab${tab === 'tester' ? ' active' : ''}`} onClick={() => setTab('tester')}>
            Strategy Tester
            {entries.length > 0 && <span className="pine-tab-count">{entries.length}</span>}
          </button>
        </div>
        <div className="pine-toolbar-spacer" />
        <span className="pine-trademark small muted">Pine Script is a trademark of TradingView, Inc. This app isn't affiliated with TradingView.</span>
        <button type="button" className="icon-button" aria-label="Hide panel" title="Hide panel (Ctrl+E)" onClick={() => setOpen(false)}>
          <ChevronDown size={16} />
        </button>
      </div>
      <div className="pine-dock-body">
        <div className="pine-pane" hidden={tab !== 'editor'}>
          <PineEditor workspace={workspace} editRequest={editRequest} onStrategyAdded={() => setTab('tester')} />
        </div>
        <div className="pine-pane" hidden={tab !== 'tester'}>
          <StrategyTester entries={entries} onOpenEditor={() => setTab('editor')} />
        </div>
      </div>
    </section>
  );
}
