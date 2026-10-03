import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { getPreference, setPreference } from '../../lib/ipc';
import { subscribeDockRequests } from '../../pine/dockBus';
import { StrategyTester } from './StrategyTester';
import { useStrategyReports } from './useStrategyReports';

const PREF_DOCK = 'pine_dock';
const MIN_HEIGHT = 200;

/** Tall enough for the tester's KPIs and equity curve, without taking over a small window. */
function defaultHeight(): number {
  return Math.min(Math.max(Math.round(window.innerHeight * 0.46), 360), 520);
}

interface DockPrefs {
  open: boolean;
  height: number;
}

interface Props {
  /** The chart's workspace: the active chart tab's, or the last one shown while another tab is. */
  workspace: VelaWorkspace | null;
  /** False while a tab that isn't a chart is showing: the dock is hidden, not unmounted, because a
   *  strategy only announces its results as it runs and a listener that started late would miss them. */
  visible: boolean;
  /** Opens the Script Editor tab (the tester's empty state links there). */
  onOpenEditor: () => void;
  /** Told whenever the dock opens or closes, for the rail's button. */
  onOpenChange?: (open: boolean) => void;
}

/** The Strategy Tester, in a resizable panel under the charts, like TradingView's. The Script Editor
 *  has a tab of its own; this stays with the chart whose strategy it reports on. */
export function PineDock({ workspace, visible, onOpenEditor, onOpenChange }: Props) {
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(defaultHeight);
  const restored = useRef(false);
  const entries = useStrategyReports(workspace, open && visible);

  useEffect(() => {
    getPreference(PREF_DOCK)
      .then((raw) => {
        if (!raw) return;
        const p = JSON.parse(raw) as Partial<DockPrefs>;
        if (typeof p.height === 'number' && p.height >= MIN_HEIGHT) setHeight(p.height);
        if (typeof p.open === 'boolean') setOpen(p.open);
      })
      .catch(() => {}) // a missing or corrupt preference just means the defaults
      .finally(() => {
        restored.current = true;
      });
  }, []);

  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  useEffect(() => onOpenChangeRef.current?.(open), [open]);

  useEffect(() => {
    if (!restored.current) return;
    setPreference(PREF_DOCK, JSON.stringify({ open, height } satisfies DockPrefs)).catch(() => {});
  }, [open, height]);

  useEffect(
    () =>
      subscribeDockRequests((request) => {
        if (request.type === 'toggle-tester') setOpen((o) => !o);
        else if (request.type === 'open-tester') setOpen(true);
      }),
    [],
  );

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
    <section className="pine-dock" hidden={!open || !visible} style={{ height }} aria-label="Strategy Tester">
      <div className="pine-resize" role="separator" aria-orientation="horizontal" aria-label="Resize panel" onPointerDown={startResize} />
      <div className="pine-dock-header">
        <div className="pine-tabs">
          <span className="pine-tab active">
            Strategy Tester
            {entries.length > 0 && <span className="pine-tab-count">{entries.length}</span>}
          </span>
        </div>
        <div className="pine-toolbar-spacer" />
        <span className="pine-trademark small muted">Pine Script is a trademark of TradingView, Inc. This app isn't affiliated with TradingView.</span>
        <button type="button" className="icon-button" aria-label="Hide panel" title="Hide panel (Ctrl+Shift+E)" onClick={() => setOpen(false)}>
          <ChevronDown size={16} />
        </button>
      </div>
      <div className="pine-dock-body">
        <div className="pine-pane">
          <StrategyTester entries={entries} onOpenEditor={onOpenEditor} />
        </div>
      </div>
    </section>
  );
}
