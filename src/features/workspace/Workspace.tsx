import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AppWindow, Bell, ChartNoAxesCombined, ChevronLeft, ChevronRight, CircleHelp, Code, Database, FlaskConical, Home, Info, KeyRound, List, ListFilter, Plug, Plus, Sparkles, SquareTerminal, X } from 'lucide-react';
import type { VelaWorkspace, WorkspaceState } from '@luxalgo/vela/workspace';
import { startAlertEngine } from '../../alerts/engine';
import { onOpenAlerts, openAlerts } from '../../alerts/ui';
import { ChartView, type ChartViewHandle } from '../../chart/ChartView';
import { ThemeSelect } from '../../components/ThemeSelect';
import { useToast } from '../../components/Toasts';
import { ensureProvidersLoaded, starterSymbol } from '../../data/providerStatus';
import {
  deleteChartLayout,
  errorMessage,
  getChartLayouts,
  getPreference,
  saveChartLayout,
  setPreference,
  type ChartLayoutRow,
} from '../../lib/ipc';
import { displayTicker, isSupportedSymbol } from '../../lib/symbols';
import { openNewWindow } from '../../lib/windows';
import { publishDockRequest, subscribeDockRequests, type DockRequest } from '../../pine/dockBus';
import { AboutDialog } from '../about/AboutDialog';
import { HelpDialog } from '../help/HelpDialog';
import { HomePage } from '../home/HomePage';
import { AlertFormDialog, type AlertFormSeed } from '../alerts/AlertFormDialog';
import { AlertsPanel } from '../alerts/AlertsPanel';
import { useAlerts } from '../alerts/useAlerts';
import { startBackgroundUpdates } from '../../updates/service';
import { useUpdateState } from '../../updates/useUpdateState';
import { ImportDataDialog } from '../datasets/ImportDataDialog';
import { PineDock } from '../pine/PineDock';
import { PineEditor } from '../pine/PineEditor';
import { PythonPanel } from '../python/PythonPanel';
import { ScreenerPanel } from '../screener/ScreenerPanel';
import { StudiesPanel } from '../studies/StudiesPanel';
import type { StudyEvent } from '../../chart/studyEvent';
import { LayoutMenu, type LayoutSummary } from '../layouts/LayoutMenu';
import { RightRail, type RailAction, type RailPanelButton } from '../rail/RightRail';
import { PanelResizer } from '../rail/PanelResizer';
import { clampPanelWidth, DEFAULT_PANEL_WIDTH, parsePanelWidth, PREF_PANEL_WIDTH } from '../rail/panelWidth';
import {
  PREF_LEGACY_WATCHLIST_COLLAPSED,
  PREF_RAIL_PANEL,
  panelAfterToggle,
  railPreferenceValue,
  restoreRailPanel,
  type RailPanelId,
} from '../rail/railPanel';
import { AiProvidersDialog, useAiProviders } from '../ai/AiProvidersDialog';
import { AskAiPanel } from '../ai/AskAiPanel';
import { DataProvidersDialog } from '../providers/DataProvidersDialog';
import { parseLayout, serializeLayout, withoutUnsupportedSymbols, type LayoutDocument } from '../layouts/layoutDocument';
import { SymbolSearchBox } from '../search/SymbolSearchBox';
import { WatchlistPanel } from '../watchlist/WatchlistPanel';
import { onOpenAddToWatchlist } from '../watchlist/watchlistUi';
import { AddToWatchlistDialog } from '../python/AddToWatchlistDialog';
import { TabQuote } from './TabQuote';
import { useTabStrip } from './tabStrip';
import { useTabQuotes } from './useTabQuotes';
import { WindowControls } from './WindowControls';
import {
  activeChartIndex,
  activeChartTab,
  canCloseTab,
  chartTabs,
  homeTab,
  isChartTab,
  pythonTab,
  pineTab,
  screenerTab,
  studiesTab,
  tabAfterClosing,
  tabAfterStep,
  type ChartTab,
  type Tab,
  WORKSPACE_LABELS,
  workspaceTabs,
} from './tabs';

/** When the alerts list was last looked at: alerts fired since then wear a badge. */
const PREF_ALERTS_SEEN = 'alerts_seen_at';
/** Set once the "how to change one chart of a grid" hint has been shown. */
const PREF_GRID_HINT = 'grid_hint_seen';

function createTab(symbol: string = starterSymbol(), initialState?: WorkspaceState): ChartTab {
  return { kind: 'chart', id: crypto.randomUUID(), symbol, initialState };
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
  const [tabs, setTabs] = useState<Tab[]>(() => [createTab()]);
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id);
  /** The chart tab last looked at, so the watchlist, alerts and the Pine dock keep talking about
   *  it while the Python tab is showing. */
  const [lastChartId, setLastChartId] = useState<string | null>(() => tabs[0].id);
  /** Charts are built once the data providers are known. */
  const [startup, setStartup] = useState<'loading' | 'ready'>('loading');
  const [layouts, setLayouts] = useState<ChartLayoutRow[]>([]);
  const [currentLayoutId, setCurrentLayoutId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  /** Which topic Help opens on, when a caller (the Home tab, a dialog) knows what to show. */
  const [helpTopic, setHelpTopic] = useState<string | undefined>(undefined);
  const openHelp = useCallback((topicId?: string) => {
    setHelpTopic(topicId);
    setHelpOpen(true);
  }, []);
  const tabStripRef = useRef<HTMLDivElement>(null);
  /** Symbols a chart's right-click menu asked to put on a watchlist. */
  const [addingToWatchlist, setAddingToWatchlist] = useState<{ symbols: string[]; newList: boolean } | null>(null);
  useEffect(() => onOpenAddToWatchlist((symbols, options) => setAddingToWatchlist({ symbols, newList: options.newList ?? false })), []);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [aiProvidersOpen, setAiProvidersOpen] = useState(false);
  const [aiProviders, reloadAiProviders] = useAiProviders();
  /** The new-alert / edit-alert form, when it is open. The list of alerts is the rail's Alerts panel. */
  const [alertForm, setAlertForm] = useState<AlertFormSeed | null>(null);
  /** Whether the Script Editor dock is open, for the rail's button. (The dock owns this; it only says so.) */
  const [dockOpen, setDockOpen] = useState(false);
  /** The panel the right rail is showing beside the chart, if any. The watchlist until saved settings say otherwise. */
  const [railPanel, setRailPanel] = useState<RailPanelId | null>('watchlist');
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  useEffect(() => {
    getPreference(PREF_PANEL_WIDTH)
      .then((raw) => setPanelWidth(clampPanelWidth(parsePanelWidth(raw), window.innerWidth)))
      .catch(() => {});
  }, []);
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
  /** What the chrome outside the tab talks about: see `activeChartTab`. */
  const chartTab = activeChartTab(tabs, activeTabId, lastChartId);
  const chartSymbol = chartTab?.symbol ?? starterSymbol();
  /** The price and day's change each chart tab wears beside its name. */
  const tabQuotes = useTabQuotes(chartTabs(tabs).map((t) => t.symbol));

  /** Shows a tab, and remembers it when it is a chart. */
  const showTab = useCallback(
    (id: string) => {
      setActiveTabId(id);
      if (tabs.some((t) => t.id === id && isChartTab(t))) setLastChartId(id);
    },
    [tabs],
  );

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
      // A layout saved before a data source was removed can hold symbols that can't load.
      const { doc: usable, replaced } = withoutUnsupportedSymbols(doc, starterSymbol());
      if (replaced > 0) {
        toast(
          `${replaced} tab${replaced === 1 ? '' : 's'} used Yahoo Finance, which is no longer a data source, and now show ${displayTicker(starterSymbol())}. The saved layout is unchanged until you save it again.`,
          'info',
        );
      }
      // A layout holds charts; the Python, Studies and Screener tabs are workspaces, not part of a saved session,
      // so they stay open across a load with their scripts, Studies and runs untouched.
      const next = usable.tabs.map((t) => createTab(t.symbol, t.state));
      chartRefs.current.clear();
      const active = next[usable.activeTabIndex] ?? next[0];
      setTabs((prev) => [...next, ...workspaceTabs(prev)]);
      setActiveTabId(active.id);
      setLastChartId(active.id);
      setCurrentLayoutId(row.id);
    },
    [toast],
  );

  // Which data providers are on, and the default. Loaded up front so search
  // and quotes know what's available; data code also waits on this itself.
  // Charts are built only once that is known.
  useEffect(() => {
    let cancelled = false;
    ensureProvidersLoaded().then(() => {
      if (!cancelled) setStartup('ready');
    });
    return () => {
      cancelled = true;
    };
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
        const parsed = def && parseLayout(def.stateJson);
        const template = parsed && withoutUnsupportedSymbols({ ...parsed, tabs: parsed.tabs.slice(0, 1) }, starterSymbol()).doc.tabs[0];
        if (template) tab = createTab(template.symbol, template.state);
      }
      const created = tab ?? createTab(symbol);
      // A new chart goes after the last one, so the workspace tabs stay on the right.
      setTabs((prev) => {
        const at = prev.findIndex((t) => !isChartTab(t));
        return at === -1 ? [...prev, created] : [...prev.slice(0, at), created, ...prev.slice(at)];
      });
      setActiveTabId(created.id);
      setLastChartId(created.id);
    },
    [layouts],
  );

  /** Opens the Home tab, or shows it when it is already open. */
  const openHome = useCallback(() => {
    const existing = homeTab(tabs);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const created: Tab = { kind: 'home', id: crypto.randomUUID() };
    setTabs((prev) => [...prev, created]);
    setActiveTabId(created.id);
  }, [tabs]);

  /** Opens the Script Editor tab, or shows it when it is already open. */
  const openPine = useCallback(() => {
    const existing = pineTab(tabs);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const created: Tab = { kind: 'pine', id: crypto.randomUUID() };
    setTabs((prev) => [...prev, created]);
    setActiveTabId(created.id);
  }, [tabs]);
  /** A chart legend's "Edit script": the Script Editor tab opens on that script. */
  const [pineEditRequest, setPineEditRequest] = useState<Extract<DockRequest, { type: 'edit-indicator' }> | null>(null);
  const openPineRef = useRef(openPine);
  openPineRef.current = openPine;
  useEffect(
    () =>
      subscribeDockRequests((request) => {
        if (request.type !== 'edit-indicator') return;
        setPineEditRequest(request);
        openPineRef.current();
      }),
    [],
  );
  /** Shows the Strategy Tester: on the chart it reports on, switching to that chart's tab if another is showing. */
  const toggleTester = useCallback(() => {
    if (activeTab && isChartTab(activeTab)) {
      publishDockRequest({ type: 'toggle-tester' });
    } else if (chartTab) {
      showTab(chartTab.id);
      publishDockRequest({ type: 'open-tester' });
    }
  }, [activeTab, chartTab, showTab]);

  /** Opens the Python workspace, or shows it when it is already open. */
  const openPython = useCallback(() => {
    const existing = pythonTab(tabs);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const created: Tab = { kind: 'python', id: crypto.randomUUID() };
    setTabs((prev) => [...prev, created]);
    setActiveTabId(created.id);
  }, [tabs]);
  /** Bumped to tell the (possibly freshly-opened) Python tab to show its settings popover —
   *  the Home tab's "Python setup" card. */
  const [pythonSettingsRequest, setPythonSettingsRequest] = useState(0);
  const openPythonSettings = useCallback(() => {
    openPython();
    setPythonSettingsRequest((n) => n + 1);
  }, [openPython]);
  /** Opens the Studies workspace, or shows it when it is already open. */
  const openStudies = useCallback(() => {
    const existing = studiesTab(tabs);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const created: Tab = { kind: 'studies', id: crypto.randomUUID() };
    setTabs((prev) => [...prev, created]);
    setActiveTabId(created.id);
  }, [tabs]);

  /** Opens the Screener workspace, or shows it when it is already open. */
  const openScreener = useCallback(() => {
    const existing = screenerTab(tabs);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const created: Tab = { kind: 'screener', id: crypto.randomUUID() };
    setTabs((prev) => [...prev, created]);
    setActiveTabId(created.id);
  }, [tabs]);

  const closeTab = useCallback(
    (id: string) => {
      if (!canCloseTab(tabs, id)) return;
      const nextActive = tabAfterClosing(tabs, id);
      if (id === activeTabId && nextActive) showTab(nextActive);
      if (id === lastChartId) setLastChartId(null);
      chartRefs.current.delete(id);
      setTabs((prev) => prev.filter((t) => t.id !== id));
    },
    [tabs, activeTabId, lastChartId, showTab],
  );

  const setTabSymbol = useCallback((id: string, symbol: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id && isChartTab(t) && t.symbol !== symbol ? { ...t, symbol } : t)));
  }, []);

  /** Routes a symbol pick — from the search box, the watchlist, the data dialog or a Python
   *  script's results — to the chart the chrome is following, and shows it. */
  const goToSymbol = useCallback(
    (symbol: string) => {
      if (!isSupportedSymbol(symbol)) {
        // e.g. a watchlist row saved when Yahoo Finance was a source: nothing can load it.
        toast(`${displayTicker(symbol)} came from a data source that is no longer available.`, 'info');
        return;
      }
      if (!chartTab) return;
      chartRefs.current.get(chartTab.id)?.setSymbol(symbol);
      setTabSymbol(chartTab.id, symbol);
      // Picked from the Python tab: show the chart it was asked for.
      if (chartTab.id !== activeTabId) showTab(chartTab.id);
    },
    [chartTab, activeTabId, showTab, setTabSymbol, toast],
  );

  /** Opens a Study's event on the chart the chrome is following: its symbol, framed around the date, marked. */
  const goToEvent = useCallback(
    (event: StudyEvent) => {
      if (!chartTab) return;
      chartRefs.current.get(chartTab.id)?.showEvent(event);
      setTabSymbol(chartTab.id, event.symbol);
      if (chartTab.id !== activeTabId) showTab(chartTab.id);
    },
    [chartTab, activeTabId, showTab, setTabSymbol],
  );

  const stepTab = useCallback((delta: number) => showTab(tabAfterStep(tabs, activeTabId, delta)), [tabs, activeTabId, showTab]);

  // Ask AI's actions on the active chart — the same handle `goToSymbol` already uses.
  const getActiveTimeframe = useCallback(() => (chartTab ? (chartRefs.current.get(chartTab.id)?.getMarket()?.timeframe ?? null) : null), [chartTab]);
  const setActiveTimeframe = useCallback((timeframe: string) => chartTab && chartRefs.current.get(chartTab.id)?.setTimeframe(timeframe), [chartTab]);
  const addActiveIndicator = useCallback(
    (name: string) => chartRefs.current.get(chartTab?.id ?? '')?.addIndicator(name) ?? Promise.resolve({ ok: false, message: 'No chart is open.' }),
    [chartTab],
  );
  const removeActiveIndicator = useCallback(
    (name: string) => chartRefs.current.get(chartTab?.id ?? '')?.removeIndicator(name) ?? Promise.resolve({ ok: false, message: 'No chart is open.' }),
    [chartTab],
  );

  // The right rail: remembered between launches, and shared by every window.
  useEffect(() => {
    Promise.all([getPreference(PREF_RAIL_PANEL), getPreference(PREF_LEGACY_WATCHLIST_COLLAPSED)])
      .then(([saved, legacyCollapsed]) => setRailPanel(restoreRailPanel(saved, legacyCollapsed)))
      .catch(() => {});
  }, []);
  const showRailPanel = useCallback((panel: RailPanelId | null) => {
    setRailPanel(panel);
    setPreference(PREF_RAIL_PANEL, railPreferenceValue(panel)).catch(() => {});
  }, []);
  const toggleRailPanel = useCallback(
    (pressed: RailPanelId) => showRailPanel(panelAfterToggle(railPanel, pressed)),
    [railPanel, showRailPanel],
  );

  // Alerts: the chart's own menus and buttons ask the app to open them — a draft opens the new-alert form,
  // none opens the alerts panel — and the workspace that is the app's main window is the one that watches
  // prices (every window shares the alerts, and two watchers would each fire them).
  useEffect(
    () =>
      onOpenAlerts((draft) => {
        if (draft) setAlertForm({ symbol: draft.symbol, price: draft.price ?? null });
        else showRailPanel('alerts');
      }),
    [showRailPanel],
  );
  useEffect(() => {
    if (getCurrentWindow().label !== 'main') return;
    return startAlertEngine();
  }, []);
  useEffect(() => {
    if (getCurrentWindow().label !== 'main') return;
    return startBackgroundUpdates();
  }, []);
  // A scheduled script runs with no window watching; one that fails is said once, here.
  useEffect(() => {
    if (getCurrentWindow().label !== 'main') return;
    let cancelled = false;
    let off: (() => void) | null = null;
    void listen<{ script: string; status: string; message: string }>('schedule-run-finished', ({ payload }) => {
      if (payload.status === 'failed') toast(`Scheduled run of ${payload.script} failed: ${payload.message}`, 'error');
    }).then((stop) => {
      if (cancelled) stop();
      else off = stop;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [toast]);
  const updateState = useUpdateState();
  const updateWaiting = updateState.kind === 'available' || updateState.kind === 'installed';
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
  // An alert that fires while its panel is open is being looked at.
  useEffect(() => {
    if (railPanel === 'alerts' && unseenAlerts > 0) markAlertsSeen();
  }, [railPanel, unseenAlerts, markAlertsSeen]);

  // App-wide shortcuts. Modifier combos only, so they never collide with
  // Vela's own type-a-letter shortcuts on the chart.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
        openAlerts({ symbol: chartSymbol });
        e.preventDefault();
        return;
      }
      if (e.key === 'F1' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        openHelp();
        e.preventDefault();
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'w') {
        toggleRailPanel('watchlist');
        e.preventDefault();
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 't' && !e.shiftKey) openTab();
      else if (key === 'w' && !e.shiftKey) closeTab(activeTabId);
      else if (key === 'k' && !e.shiftKey) searchRef.current?.focus();
      else if (key === 'n' && e.shiftKey) openNewWindow();
      else if (key === 'y' && e.shiftKey) openPython();
      else if (key === 'e' && !e.shiftKey) openPine();
      else if (key === 'e' && e.shiftKey) toggleTester();
      else if (e.key === 'PageDown') stepTab(1);
      else if (e.key === 'PageUp') stepTab(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openTab, closeTab, stepTab, openPython, openPine, toggleTester, toggleRailPanel, openHelp, activeTabId, chartSymbol]);

  /** Never silently drops the save. A tab that was never shown has no live
   *  chart (see ChartView), so it falls back to its own last-known state —
   *  untouched, since nothing could have changed it without a live chart —
   *  and to symbol-only if it never had one. */
  function captureLayoutDocument(): LayoutDocument {
    // Charts only: the Python tab holds scripts and a console, which aren't part of a chart session.
    const tabDocs = chartTabs(tabs).map((t) => {
      const state = chartRefs.current.get(t.id)?.getState() ?? t.initialState;
      return state ? { symbol: t.symbol, state } : { symbol: t.symbol };
    });
    return { version: 1, tabs: tabDocs, activeTabIndex: activeChartIndex(tabs, activeTabId, lastChartId) };
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

  const railPanels: RailPanelButton[] = [
    { id: 'watchlist', label: 'Watchlist', shortcut: 'Alt+W', icon: List },
    { id: 'alerts', label: unseenAlerts > 0 ? `Price alerts — ${unseenAlerts} fired` : 'Price alerts', icon: Bell, badge: unseenAlerts },
    { id: 'assistant', label: 'Ask AI', shortcut: 'Alt+A', icon: Sparkles },
  ];
  // The dock and the Python tab each belong to the tab showing: the dock is a chart's, so it isn't showing
  // while the Python tab is.
  const railTools: RailAction[] = [
    {
      id: 'home',
      label: 'Home',
      title: 'Home: an overview of the application',
      icon: Home,
      pressed: activeTab?.kind === 'home',
      onClick: openHome,
    },
    {
      id: 'script-editor',
      label: 'Script Editor',
      title: 'Script Editor: write Pine Script indicators and strategies (Ctrl+E)',
      icon: Code,
      pressed: activeTab?.kind === 'pine',
      onClick: openPine,
    },
    {
      id: 'strategy-tester',
      label: 'Strategy Tester',
      title: "Strategy Tester: a strategy's backtest on the chart (Ctrl+Shift+E)",
      icon: ChartNoAxesCombined,
      pressed: dockOpen && !!activeTab && isChartTab(activeTab),
      onClick: toggleTester,
    },
    {
      id: 'python',
      label: 'Python',
      title: "Python: screen and backtest with your broker's data (Ctrl+Shift+Y)",
      icon: SquareTerminal,
      pressed: activeTab?.kind === 'python',
      onClick: openPython,
    },
    {
      id: 'studies',
      label: 'Studies',
      title: 'Studies: what stocks looked like around historical events',
      icon: FlaskConical,
      pressed: activeTab?.kind === 'studies',
      onClick: openStudies,
    },
    {
      id: 'screener',
      label: 'Screener',
      title: 'Screener: which stocks match your conditions today',
      icon: ListFilter,
      pressed: activeTab?.kind === 'screener',
      onClick: openScreener,
    },
  ];
  const railFooter: RailAction[] = [
    { id: 'import-data', label: 'Import data', title: 'Import your own data (CSV)', icon: Database, onClick: () => setImportOpen(true) },
    { id: 'new-window', label: 'New window', title: 'New window (Ctrl+Shift+N)', icon: AppWindow, onClick: openNewWindow },
    { id: 'data-providers', label: 'Data providers', title: 'Data providers: where prices come from', icon: Plug, onClick: () => setProvidersOpen(true) },
    { id: 'ai-providers', label: 'AI providers', title: 'AI providers: API keys for Claude, GPT and which one to use', icon: KeyRound, onClick: () => setAiProvidersOpen(true) },
    { id: 'help', label: 'Help', title: 'Help: how every part of the app works (F1)', icon: CircleHelp, pressed: helpOpen, onClick: () => openHelp() },
    {
      id: 'about',
      label: 'About',
      title: updateWaiting ? 'About & shortcuts — an update is available' : 'About & shortcuts',
      icon: Info,
      dot: updateWaiting,
      onClick: () => setAboutOpen(true),
    },
  ];

  async function handleDeleteLayout(id: string) {
    try {
      await deleteChartLayout(id);
      setLayouts(await getChartLayouts());
      if (currentLayoutId === id) setCurrentLayoutId(null);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  // What Ask AI is told is open — the same labels the tab bar itself shows.
  const openTabLabels = tabs.map((tab) => (isChartTab(tab) ? displayTicker(tab.symbol) : WORKSPACE_LABELS[tab.kind]));

  const tabStrip = useTabStrip(tabStripRef, activeTabId, tabs.length);

  return (
    <div className="app">
      <div className="tab-bar">
        {/* The window's own title bar (decorations: false — see WindowControls.tsx): the brand mark and
            the spacer further along are what's draggable, so tabs and buttons still work normally. */}
        <div className="tab-brand" data-tauri-drag-region>
          <img src="/favicon-32.png" alt="ProTradeChart" />
        </div>
        {/* As wide as its tabs, up to the room there is; the arrows sit over its edges, so showing them
            never takes room from the tabs. */}
        <div className="tab-strip">
        <div
          className={`tab-bar-scroll${tabStrip.overflow.left ? ' fade-left' : ''}${tabStrip.overflow.right ? ' fade-right' : ''}`}
          role="tablist"
          ref={tabStripRef}
        >
          {tabs.map((tab) => {
            const label = isChartTab(tab) ? displayTicker(tab.symbol) : WORKSPACE_LABELS[tab.kind];
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={tab.id === activeTabId}
                className={`tab-chip${tab.id === activeTabId ? ' active' : ''}${isChartTab(tab) ? '' : ' python'}`}
                title={label}
                onClick={() => showTab(tab.id)}
                onAuxClick={(e) => e.button === 1 && closeTab(tab.id)}
              >
                {tab.kind === 'home' && <Home size={13} aria-hidden="true" />}
                {tab.kind === 'pine' && <Code size={13} aria-hidden="true" />}
                {tab.kind === 'python' && <SquareTerminal size={13} aria-hidden="true" />}
                {tab.kind === 'studies' && <FlaskConical size={13} aria-hidden="true" />}
                {tab.kind === 'screener' && <ListFilter size={13} aria-hidden="true" />}
                <span className="tab-chip-label">{label}</span>
                {isChartTab(tab) && <TabQuote symbol={tab.symbol} quote={tabQuotes.get(tab.symbol)} />}
                {canCloseTab(tabs, tab.id) && (
                  <button
                    type="button"
                    className="tab-chip-close"
                    aria-label={`Close ${label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {tabStrip.overflow.left && (
          <button type="button" className="icon-button tab-scroll left" aria-label="Show earlier tabs" title="Earlier tabs" onClick={() => tabStrip.scrollBy(-1)}>
            <ChevronLeft size={15} />
          </button>
        )}
        {tabStrip.overflow.right && (
          <button type="button" className="icon-button tab-scroll right" aria-label="Show later tabs" title="Later tabs" onClick={() => tabStrip.scrollBy(1)}>
            <ChevronRight size={15} />
          </button>
        )}
        </div>
        {/* Outside the strip, so it stays in reach however many tabs are open. */}
        <button type="button" className="icon-button tab-new" aria-label="New chart tab" title="New tab (Ctrl+T)" onClick={() => openTab()}>
          <Plus size={15} />
        </button>
        <div className="tab-bar-drag" data-tauri-drag-region />

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
          <ThemeSelect />
        </div>
        <WindowControls />
      </div>

      <div className="app-body" style={{ "--side-panel-width": `${panelWidth}px` } as React.CSSProperties}>
        <div className="app-main">
          <div className="app-canvases">
            {startup === 'ready' && tabs.map((tab) => (
              <div key={tab.id} className={tab.id === activeTabId ? 'tab-panel' : undefined} style={tab.id === activeTabId ? undefined : { display: 'none' }}>
                {isChartTab(tab) ? (
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
                ) : tab.kind === 'home' ? (
                  <HomePage
                    layouts={layouts.map(toSummary)}
                    aiProviders={aiProviders}
                    onNewChart={() => openTab()}
                    onNewWindow={openNewWindow}
                    onOpenLayout={(id) => {
                      const row = layouts.find((l) => l.id === id);
                      if (row) applyLayoutRow(row);
                    }}
                    onOpenWatchlist={() => showRailPanel('watchlist')}
                    onOpenAlerts={() => showRailPanel('alerts')}
                    onOpenAskAi={() => showRailPanel('assistant')}
                    onOpenScriptEditor={openPine}
                    onOpenPython={openPython}
                    onOpenPythonSetup={openPythonSettings}
                    onOpenStudies={openStudies}
                    onOpenScreener={openScreener}
                    onOpenDataProviders={() => setProvidersOpen(true)}
                    onOpenAiProviders={() => setAiProvidersOpen(true)}
                    onOpenImportData={() => setImportOpen(true)}
                    onOpenAbout={() => setAboutOpen(true)}
                    onOpenHelp={openHelp}
                  />
                ) : tab.kind === 'pine' ? (
                  // Stays mounted, so the script being written is still there when you come back.
                  <PineEditor
                    workspace={chartTab ? (workspaces[chartTab.id] ?? null) : null}
                    chartLabel={chartTab ? displayTicker(chartTab.symbol) : null}
                    editRequest={pineEditRequest}
                    onStrategyAdded={() => publishDockRequest({ type: 'open-tester' })}
                    onShowChart={() => chartTab && showTab(chartTab.id)}
                  />
                ) : tab.kind === 'screener' ? (
                  // Stays mounted, like Studies, so a running screen keeps going while charts are looked at.
                  <ScreenerPanel visible={tab.id === activeTabId} onOpenSymbol={goToSymbol} />
                ) : tab.kind === 'studies' ? (
                  // Stays mounted, like Python, so a running Study keeps going while charts are looked at.
                  <StudiesPanel visible={tab.id === activeTabId} onOpenEvent={goToEvent} onOpenPython={openPython} />
                ) : (
                  // Stays mounted while another tab shows, so a run keeps going and its console
                  // and results are still there when you come back.
                  <PythonPanel visible={tab.id === activeTabId} onOpenSymbol={goToSymbol} openSettings={pythonSettingsRequest} />
                )}
              </div>
            ))}
          </div>
          {/* The Strategy Tester belongs to a chart: hidden while a workspace tab is showing, but kept mounted
              on the last chart so a strategy added from the Script Editor tab is still reported. */}
          {chartTab && (
            <PineDock
              workspace={workspaces[chartTab.id] ?? null}
              visible={!!activeTab && isChartTab(activeTab)}
              onOpenEditor={openPine}
              onOpenChange={setDockOpen}
            />
          )}
        </div>
        {railPanel !== null && (
          <PanelResizer
            width={panelWidth}
            onResize={setPanelWidth}
            onCommit={(width) => void setPreference(PREF_PANEL_WIDTH, String(width)).catch(() => {})}
          />
        )}
        {/* The watchlist stays mounted while another panel shows, so its list, sort and scroll are still there. */}
        <WatchlistPanel
          visible={railPanel === 'watchlist'}
          activeSymbol={chartSymbol}
          onSelectSymbol={goToSymbol}
          onOpenInNewTab={openTab}
        />
        {railPanel === 'alerts' && (
          <AlertsPanel
            alerts={alerts}
            onSelectSymbol={goToSymbol}
            onNew={() => setAlertForm({ symbol: chartSymbol, price: null })}
            onEdit={(alert) => setAlertForm({ alert, symbol: alert.symbol, price: alert.price })}
          />
        )}
        {/* Stays mounted too, so the conversation is still there when you come back. */}
        <AskAiPanel
          visible={railPanel === 'assistant'}
          activeSymbol={chartSymbol}
          openTabs={openTabLabels}
          getTimeframe={getActiveTimeframe}
          onOpenSymbol={goToSymbol}
          onSetTimeframe={setActiveTimeframe}
          onAddIndicator={addActiveIndicator}
          onRemoveIndicator={removeActiveIndicator}
          say={toast}
        />
        <RightRail panels={railPanels} activePanel={railPanel} onTogglePanel={toggleRailPanel} tools={railTools} footer={railFooter} />
      </div>

      {importOpen && <ImportDataDialog onClose={() => setImportOpen(false)} onOpenSymbol={goToSymbol} />}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
      {helpOpen && <HelpDialog initialTopic={helpTopic} onClose={() => setHelpOpen(false)} />}
      {addingToWatchlist && (
        <AddToWatchlistDialog
          symbols={addingToWatchlist.symbols}
          startWithNewList={addingToWatchlist.newList}
          newListName="My watchlist"
          onClose={() => setAddingToWatchlist(null)}
          say={(level, text) => toast(text, level === 'error' ? 'error' : 'success')}
        />
      )}
      {providersOpen && <DataProvidersDialog onClose={() => setProvidersOpen(false)} />}
      {aiProvidersOpen && <AiProvidersDialog providers={aiProviders} onClose={() => setAiProvidersOpen(false)} onChanged={reloadAiProviders} say={toast} />}
      {alertForm && <AlertFormDialog seed={alertForm} onClose={() => setAlertForm(null)} />}
    </div>
  );
}
