import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AppWindow, Bell, Code, Database, Info, Plug, Plus, X } from 'lucide-react';
import type { VelaWorkspace, WorkspaceState } from '@luxalgo/vela/workspace';
import { startAlertEngine } from '../../alerts/engine';
import { onOpenAlerts, openAlerts, type AlertDraft } from '../../alerts/ui';
import { ChartView, type ChartViewHandle } from '../../chart/ChartView';
import { ThemeSelect } from '../../components/ThemeSelect';
import { useToast } from '../../components/Toasts';
import { ensureProvidersLoaded } from '../../data/providerStatus';
import {
  deleteChartLayout,
  errorMessage,
  getChartLayouts,
  getPreference,
  saveChartLayout,
  setPreference,
  type ChartLayoutRow,
} from '../../lib/ipc';
import { displayTicker } from '../../lib/symbols';
import { openNewWindow } from '../../lib/windows';
import { publishDockRequest } from '../../pine/dockBus';
import { AboutDialog } from '../about/AboutDialog';
import { AlertsDialog } from '../alerts/AlertsDialog';
import { useAlerts } from '../alerts/useAlerts';
import { ImportDataDialog } from '../datasets/ImportDataDialog';
import { PineDock } from '../pine/PineDock';
import { LayoutMenu, type LayoutSummary } from '../layouts/LayoutMenu';
import { DataProvidersDialog } from '../providers/DataProvidersDialog';
import { parseLayout, serializeLayout, type LayoutDocument } from '../layouts/layoutDocument';
import { SymbolSearchBox } from '../search/SymbolSearchBox';
import { WatchlistPanel } from '../watchlist/WatchlistPanel';

interface ChartTab {
  id: string;
  /** Fully-qualified `provider:TICKER`. Tracks the chart's own symbol. */
  symbol: string;
  /** Only set when this tab was just restored from a saved layout — consumed
   *  once by ChartView at construction. */
  initialState?: WorkspaceState;
}

const DEFAULT_SYMBOL = 'yahoo:AAPL';
/** When the alerts list was last looked at: alerts fired since then wear a badge. */
const PREF_ALERTS_SEEN = 'alerts_seen_at';
/** Set once the "how to change one chart of a grid" hint has been shown. */
const PREF_GRID_HINT = 'grid_hint_seen';

function createTab(symbol: string = DEFAULT_SYMBOL, initialState?: WorkspaceState): ChartTab {
  return { id: crypto.randomUUID(), symbol, initialState };
}

function toSummary(row: ChartLayoutRow): LayoutSummary {
  return { id: row.id, name: row.name, isDefault: row.isDefault };
}

/** The whole app: a browser-style tab bar (one chart per tab), the chart
 *  itself, and a watchlist docked on the right. The symbol search, layout menu
 *  and watchlist are shared chrome, not per-tab — picking a symbol from any of
 *  them loads it into whichever tab is active. Layouts save and restore the
 *  whole tab set as one named session. The theme is not part of a layout. */
export function Workspace() {
  const toast = useToast();
  const [tabs, setTabs] = useState<ChartTab[]>(() => [createTab()]);
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id);
  const [layouts, setLayouts] = useState<ChartLayoutRow[]>([]);
  const [currentLayoutId, setCurrentLayoutId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState<{ draft: AlertDraft | null } | null>(null);
  const { alerts } = useAlerts();
  const [alertsSeenAt, setAlertsSeenAt] = useState<number | null>(null);
  const chartRefs = useRef<Map<string, ChartViewHandle>>(new Map());
  // Each tab's live workspace (null until its chart is built), for chrome shared across tabs.
  const [workspaces, setWorkspaces] = useState<Record<string, VelaWorkspace | null>>({});
  const setTabWorkspace = useCallback((id: string, ws: VelaWorkspace | null) => {
    setWorkspaces((prev) => (prev[id] === ws ? prev : { ...prev, [id]: ws }));
  }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  const bootedDefaultLayout = useRef(false);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  // New charts of a grid start on the tab's symbol; how to give one its own is
  // not obvious, so say so — once, ever.
  const showGridHint = useCallback(async () => {
    try {
      if ((await getPreference(PREF_GRID_HINT)) === '1') return;
      await setPreference(PREF_GRID_HINT, '1');
    } catch {
      return; // a hint isn't worth a second failure toast
    }
    toast('Click a chart to select it, then search or click a watchlist symbol to change just that chart.', 'info');
  }, [toast]);

  const applyLayoutRow = useCallback(
    (row: ChartLayoutRow) => {
      const doc = parseLayout(row.stateJson);
      if (!doc) {
        // A corrupt row shouldn't take the window down — the current session
        // stays as it was, and the user is told why nothing happened.
        toast(`The layout "${row.name}" is damaged and couldn't be loaded.`, 'error');
        return;
      }
      const next = doc.tabs.map((t) => createTab(t.symbol, t.state));
      chartRefs.current.clear();
      setTabs(next);
      setActiveTabId(next[doc.activeTabIndex].id);
      setCurrentLayoutId(row.id);
    },
    [toast],
  );

  // Which data providers are on, and the default. Loaded up front so search
  // and quotes know what's available; data code also waits on this itself.
  useEffect(() => {
    void ensureProvidersLoaded();
  }, []);

  // Load saved layouts once; the default one (if any) becomes the starting session.
  useEffect(() => {
    (async () => {
      try {
        const rows = await getChartLayouts();
        setLayouts(rows);
        if (bootedDefaultLayout.current) return;
        bootedDefaultLayout.current = true;
        const def = rows.find((r) => r.isDefault);
        if (def) applyLayoutRow(def);
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A "+" new tab starts from the default layout's first chart — same symbol,
   *  indicators, drawings and style — so the default layout doubles as a
   *  template for new tabs, not just the session restored at launch. */
  const openTab = useCallback(
    (symbol?: string) => {
      let tab: ChartTab | null = null;
      if (!symbol) {
        const def = layouts.find((l) => l.isDefault);
        const template = def && parseLayout(def.stateJson)?.tabs[0];
        if (template) tab = createTab(template.symbol, template.state);
      }
      const created = tab ?? createTab(symbol);
      setTabs((prev) => [...prev, created]);
      setActiveTabId(created.id);
    },
    [layouts],
  );

  const closeTab = useCallback(
    (id: string) => {
      if (tabs.length <= 1) return; // always keep at least one tab open
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const next = tabs.filter((t) => t.id !== id);
      if (id === activeTabId) setActiveTabId((next[idx - 1] ?? next[idx] ?? next[0]).id);
      chartRefs.current.delete(id);
      setTabs(next);
    },
    [tabs, activeTabId],
  );

  const setTabSymbol = useCallback((id: string, symbol: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id && t.symbol !== symbol ? { ...t, symbol } : t)));
  }, []);

  /** Routes a symbol pick — from the search box, the watchlist or the data
   *  dialog — to whichever tab is active. */
  const goToSymbol = useCallback(
    (symbol: string) => {
      chartRefs.current.get(activeTab.id)?.setSymbol(symbol);
      setTabSymbol(activeTab.id, symbol);
    },
    [activeTab.id, setTabSymbol],
  );

  const stepTab = useCallback(
    (delta: number) => {
      const idx = tabs.findIndex((t) => t.id === activeTabId);
      setActiveTabId(tabs[(idx + delta + tabs.length) % tabs.length].id);
    },
    [tabs, activeTabId],
  );

  // Alerts: the chart's own menus and buttons ask the app to open the dialog,
  // and the workspace that is the app's main window is the one that watches prices
  // (every window shares the alerts, and two watchers would each fire them).
  useEffect(() => onOpenAlerts((draft) => setAlertsOpen({ draft })), []);
  useEffect(() => {
    if (getCurrentWindow().label !== 'main') return;
    return startAlertEngine();
  }, []);
  useEffect(() => {
    getPreference(PREF_ALERTS_SEEN)
      .then((v) => setAlertsSeenAt(v ? Number(v) : Date.now()))
      .catch(() => setAlertsSeenAt(Date.now()));
  }, []);
  const markAlertsSeen = useCallback(() => {
    const now = Date.now();
    setAlertsSeenAt(now);
    setPreference(PREF_ALERTS_SEEN, String(now)).catch(() => {});
  }, []);
  const unseenAlerts =
    alertsSeenAt === null ? 0 : alerts.filter((a) => a.triggeredAt !== null && a.triggeredAt > alertsSeenAt).length;

  // App-wide shortcuts. Modifier combos only, so they never collide with
  // Vela's own type-a-letter shortcuts on the chart.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
        openAlerts({ symbol: activeTab.symbol });
        e.preventDefault();
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 't' && !e.shiftKey) openTab();
      else if (key === 'w' && !e.shiftKey) closeTab(activeTabId);
      else if (key === 'k' && !e.shiftKey) searchRef.current?.focus();
      else if (key === 'n' && e.shiftKey) openNewWindow();
      else if (e.key === 'PageDown') stepTab(1);
      else if (e.key === 'PageUp') stepTab(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openTab, closeTab, stepTab, activeTabId, activeTab.symbol]);

  /** Never silently drops the save. A tab that was never shown has no live
   *  chart (see ChartView), so it falls back to its own last-known state —
   *  untouched, since nothing could have changed it without a live chart —
   *  and to symbol-only if it never had one. */
  function captureLayoutDocument(): LayoutDocument {
    const tabDocs = tabs.map((t) => {
      const state = chartRefs.current.get(t.id)?.getState() ?? t.initialState;
      return state ? { symbol: t.symbol, state } : { symbol: t.symbol };
    });
    const activeIdx = tabs.findIndex((t) => t.id === activeTabId);
    return { version: 1, tabs: tabDocs, activeTabIndex: Math.max(0, activeIdx) };
  }

  async function persistLayout(id: string, name: string, isDefault: boolean) {
    try {
      const existing = layouts.find((l) => l.id === id);
      const now = new Date().toISOString();
      await saveChartLayout({
        id,
        name,
        stateJson: serializeLayout(captureLayoutDocument()),
        isDefault,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      setLayouts(await getChartLayouts());
      setCurrentLayoutId(id);
      toast(`Saved layout “${name}”.`, 'success');
    } catch (err) {
      toast(`Couldn't save the layout: ${errorMessage(err)}`, 'error');
    }
  }

  const currentLayout = layouts.find((l) => l.id === currentLayoutId);

  async function handleDeleteLayout(id: string) {
    try {
      await deleteChartLayout(id);
      setLayouts(await getChartLayouts());
      if (currentLayoutId === id) setCurrentLayoutId(null);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  return (
    <div className="app">
      <div className="tab-bar">
        <div className="tab-bar-scroll" role="tablist">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeTabId}
              className={`tab-chip${tab.id === activeTabId ? ' active' : ''}`}
              onClick={() => setActiveTabId(tab.id)}
              onAuxClick={(e) => e.button === 1 && closeTab(tab.id)}
            >
              <span className="tab-chip-label">{displayTicker(tab.symbol)}</span>
              {tabs.length > 1 && (
                <button
                  type="button"
                  className="tab-chip-close"
                  aria-label={`Close ${displayTicker(tab.symbol)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
          <button type="button" className="icon-button" style={{ margin: '0 4px 4px', flexShrink: 0 }} aria-label="New chart tab" title="New tab (Ctrl+T)" onClick={() => openTab()}>
            <Plus size={15} />
          </button>
        </div>

        <div className="tab-bar-actions">
          <LayoutMenu
            layouts={layouts.map(toSummary)}
            currentLayoutId={currentLayoutId}
            onSelect={(id) => {
              const row = layouts.find((l) => l.id === id);
              if (row) applyLayoutRow(row);
            }}
            onSave={() => currentLayout && persistLayout(currentLayout.id, currentLayout.name, currentLayout.isDefault)}
            onSaveAsNew={(name) => persistLayout(crypto.randomUUID(), name, false)}
            onSetDefault={() => currentLayout && persistLayout(currentLayout.id, currentLayout.name, true)}
            onDelete={handleDeleteLayout}
          />
          <SymbolSearchBox ref={searchRef} onSelect={(picked) => goToSymbol(picked.symbol)} />
          <span className="tab-bar-divider" />
          <button
            type="button"
            className="icon-button bell-button"
            aria-label="Price alerts"
            title={unseenAlerts > 0 ? `Price alerts (${unseenAlerts} fired) — Alt+A` : 'Price alerts (Alt+A)'}
            onClick={() => {
              markAlertsSeen();
              setAlertsOpen({ draft: null });
            }}
          >
            <Bell size={15} />
            {unseenAlerts > 0 && <span className="icon-badge">{unseenAlerts > 9 ? '9+' : unseenAlerts}</span>}
          </button>
          <button type="button" className="icon-button" aria-label="Pine Editor" title="Pine Editor and Strategy Tester (Ctrl+E)" onClick={() => publishDockRequest({ type: 'toggle' })}>
            <Code size={15} />
          </button>
          <button type="button" className="icon-button" aria-label="Data providers" title="Data providers: where prices come from" onClick={() => setProvidersOpen(true)}>
            <Plug size={15} />
          </button>
          <button type="button" className="icon-button" aria-label="Import data" title="Import your own data (CSV)" onClick={() => setImportOpen(true)}>
            <Database size={15} />
          </button>
          <button type="button" className="icon-button" aria-label="New window" title="New window (Ctrl+Shift+N)" onClick={openNewWindow}>
            <AppWindow size={15} />
          </button>
          <ThemeSelect />
          <button type="button" className="icon-button" aria-label="About" title="About & shortcuts" onClick={() => setAboutOpen(true)}>
            <Info size={15} />
          </button>
        </div>
      </div>

      <div className="app-body">
        <div className="app-main">
          <div className="app-canvases">
            {tabs.map((tab) => (
              <div key={tab.id} className={tab.id === activeTabId ? 'tab-panel' : undefined} style={tab.id === activeTabId ? undefined : { display: 'none' }}>
                <ChartView
                  ref={(handle) => {
                    if (handle) chartRefs.current.set(tab.id, handle);
                    else chartRefs.current.delete(tab.id);
                  }}
                  initialSymbol={tab.symbol}
                  initialState={tab.initialState}
                  onSymbolChange={(symbol) => setTabSymbol(tab.id, symbol)}
                  onGridGrow={showGridHint}
                  onWorkspace={(ws) => setTabWorkspace(tab.id, ws)}
                />
              </div>
            ))}
          </div>
          <PineDock workspace={workspaces[activeTab.id] ?? null} />
        </div>
        <WatchlistPanel activeSymbol={activeTab.symbol} onSelectSymbol={goToSymbol} />
      </div>

      {importOpen && <ImportDataDialog onClose={() => setImportOpen(false)} onOpenSymbol={goToSymbol} />}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
      {providersOpen && <DataProvidersDialog onClose={() => setProvidersOpen(false)} />}
      {alertsOpen && (
        <AlertsDialog
          draft={alertsOpen.draft}
          defaultSymbol={activeTab.symbol}
          onClose={() => {
            setAlertsOpen(null);
            markAlertsSeen();
          }}
        />
      )}
    </div>
  );
}
