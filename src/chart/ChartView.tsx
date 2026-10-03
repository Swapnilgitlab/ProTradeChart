import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { TimelineMark } from '@luxalgo/vela';
import { VelaWorkspace, type WorkspaceState } from '@luxalgo/vela/workspace';
import { providerFactories } from '../data/providers';
import { withChartSymbols } from '../features/layouts/layoutDocument';
import { chartSymbol, normalizeSymbol } from '../lib/symbols';
import { BUNDLED_MANIFEST } from '../pine/bundled';
import { useTheme } from '../theme/ThemeProvider';
import { trackCursorPrice } from './alertActions';
import { attributionInk, chosenBackground } from './canvasBackground';
import { watchHistory } from './historyBackfill';
import { setEventMark, showStudyEvent, type StudyEvent } from './studyEvent';
import { installThinMovingAverages } from './thinMovingAverages';
import { tidyStatusline } from './statuslineMeta';
import { watchSymbolDrawings } from './symbolDrawings';
import { showCompanyName } from './watermarkName';

// Vela's own default grid hues, at 20% opacity — the same neutral gray it
// already picks per light/dark, only more subtle. `setTheme()` re-skins the
// chart from the theme's own solid gridColor, so this needs reapplying after
// every theme switch, and for every cell of the grid — including ones a later
// layout change brings in — not just the first chart at construction.
const GRID_COLOR = { light: 'rgba(204, 204, 204, 0.2)', dark: 'rgba(32, 34, 44, 0.2)' } as const;

export function applyGridOpacity(ws: VelaWorkspace, baseMode: 'light' | 'dark') {
  for (const cell of ws.cells()) {
    try {
      cell.chart.renderer.applyConfig({
        grid: {
          vertLines: { color: GRID_COLOR[baseMode] },
          horzLines: { color: GRID_COLOR[baseMode] },
        },
      });
    } catch {
      // A cell still being built has no renderer yet; the layout-changed pass covers it.
    }
  }
}

/** Vela's workspace draws one attribution mark over the grid and inks it from the app theme, not
 *  from the canvas it sits on — black on a dark background a layout chose under a light theme, where
 *  it would all but vanish. The mark must stay visible (Vela's licence terms), so it is re-inked
 *  from the background of the cell it is in, the way Vela inks it for a theme. */
export function tintAttribution(ws: VelaWorkspace) {
  for (const cell of ws.cells()) {
    let background: unknown;
    try {
      background = (cell.chart.renderer.getConfig() as { layout?: { background?: unknown } }).layout?.background;
    } catch {
      continue; // a cell still being built
    }
    const ink = attributionInk(background);
    for (const mark of cell.host.querySelectorAll<HTMLElement>('.vela-attribution')) {
      mark.style.color = ink.color;
      mark.style.setProperty('--vela-attr-shadow', ink.shadow);
    }
  }
}

/** Switches the tab to a theme, keeping the canvas background of any chart that has one of its own
 *  (from its layout, or picked in its settings): Vela's `setTheme` re-skins every chart, and the
 *  theme should only fill in where no background was chosen (see canvasBackground.ts). */
export function applyTheme(ws: VelaWorkspace, baseMode: 'light' | 'dark') {
  const chosen = ws.cells().map((cell) => {
    try {
      return { chart: cell.chart, background: chosenBackground(cell.chart.renderer.getConfig()) };
    } catch {
      return { chart: cell.chart, background: null }; // a cell still being built
    }
  });
  ws.setTheme(baseMode);
  for (const { chart, background } of chosen) {
    if (!background) continue;
    try {
      chart.renderer.applyConfig({ layout: { background } });
    } catch {
      // A cell that went away with the switch.
    }
  }
  applyGridOpacity(ws, baseMode);
  tintAttribution(ws);
}

/** Starts watching every chart of `ws` that isn't already: loading older
 *  history as the user scrolls or zooms back (see historyBackfill.ts),
 *  remembering the price under the cursor for "add alert here", putting the
 *  company name under the symbol watermark (see watermarkName.ts), and keeping
 *  drawings with their symbol (see symbolDrawings.ts).
 *  Cells come and go with layout changes, so this is safe to call repeatedly. */
function watchAllCells(ws: VelaWorkspace, watched: Map<object, () => void>) {
  const cells = ws.cells();
  const live = new Set<object>(cells.map((cell) => cell.chart));
  for (const [chart, stop] of watched) {
    // A cell Vela rebuilt (or dropped) leaves its old chart behind.
    if (!live.has(chart)) {
      stop();
      watched.delete(chart);
    }
  }
  for (const cell of cells) {
    const chart = cell.chart;
    if (!watched.has(chart)) {
      const stops = [
        watchHistory(chart),
        trackCursorPrice(chart),
        showCompanyName(cell),
        tidyStatusline(cell),
        watchSymbolDrawings(chart),
        // A background picked in the chart's settings re-inks the attribution mark.
        chart.renderer.onConfigChanged(() => tintAttribution(ws)),
      ];
      watched.set(chart, () => stops.forEach((stop) => stop()));
    }
  }
}

/** The machine's IANA timezone, e.g. `Asia/Kolkata`. */
export const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** What an Ask AI action reports back, for its confirmation card. */
export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface ChartViewHandle {
  /** Points the tab's active chart at a new `provider:TICKER` symbol. */
  setSymbol: (symbol: string) => void;
  /** Opens a Study's event on the tab's active chart: that symbol, daily, framed around the event
   *  date, with a mark on its bar. */
  showEvent: (event: StudyEvent) => void;
  /** Every chart in the tab's grid — layout, timeframes, indicators, drawings,
   *  renderer config — for saving as part of a layout. Not just the symbol. */
  getState: () => WorkspaceState | null;
  /** The active chart's current symbol and timeframe, for Ask AI's "what's on screen" context. */
  getMarket: () => { symbol: string; timeframe: string } | null;
  /** Changes the active chart's timeframe in place (e.g. "D", "60", "5"). Ask AI only — the
   *  timeframe picker in Vela's own toolbar doesn't go through this. */
  setTimeframe: (timeframe: string) => void;
  /** Adds a built-in indicator to the active chart by its display name (matched case-insensitively
   *  against Vela's native-indicator catalog). Ask AI only. */
  addIndicator: (name: string) => Promise<ActionResult>;
  /** Removes an indicator already on the active chart by its display name. Ask AI only. */
  removeIndicator: (name: string) => Promise<ActionResult>;
}

interface Props {
  initialSymbol: string;
  /** A previously-saved `getState()` document to restore on construction
   *  (loading a saved layout) — applied once, right after the chart is built.
   *  Never re-applied on prop change: Vela owns its state past construction. */
  initialState?: WorkspaceState;
  /** Fires whenever the tab's active chart shows a different symbol — via
   *  `setSymbol`, from inside Vela's own UI, or by clicking another chart of
   *  the grid — so the owning tab can keep its label in sync. */
  onSymbolChange: (symbol: string) => void;
  /** Fires when the grid grows from a single chart to several — the moment a
   *  user is likely to wonder how to put a different symbol in each. Not fired
   *  for a grid restored from a saved layout. */
  onGridGrow?: () => void;
  /** Hands the tab's workspace to the app once it has been built, and `null` when it
   *  is destroyed — for shared chrome (the Pine dock) that acts on the active tab's
   *  charts. Don't hold a chart from it: cells come and go. */
  onWorkspace?: (ws: VelaWorkspace | null) => void;
}

/** A grid of one to sixteen charts (1×1 to 4×4, picked from the layout button in
 *  Vela's toolbar) wrapping its `VelaWorkspace` shell — the content of one tab.
 *  The tab's symbol is that of the *active* chart, the one last clicked.
 *  `initialSymbol` / `initialState` seed construction only; afterwards the
 *  symbol is driven through the imperative handle, never by re-rendering with
 *  new props. */
export const ChartView = forwardRef<ChartViewHandle, Props>(function ChartView(
  { initialSymbol, initialState, onSymbolChange, onGridGrow, onWorkspace },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<VelaWorkspace | null>(null);
  const onWorkspaceRef = useRef(onWorkspace);
  onWorkspaceRef.current = onWorkspace;
  const onSymbolChangeRef = useRef(onSymbolChange);
  onSymbolChangeRef.current = onSymbolChange;
  const onGridGrowRef = useRef(onGridGrow);
  onGridGrowRef.current = onGridGrow;
  const cellCountRef = useRef<number | null>(null);
  /** Charts whose history is being extended on demand, and how to stop that. */
  const watchedRef = useRef(new Map<object, () => void>());
  // A symbol chosen before the chart has been built (a brand-new or
  // never-shown tab) is remembered and used for construction, not dropped.
  const pendingSymbolRef = useRef<string | null>(null);
  /** The same for a Study event asked for before the chart exists. */
  const pendingEventRef = useRef<StudyEvent | null>(null);
  /** A Study event's mark and the symbol it belongs to: re-applied when that symbol's load lands, and
   *  dropped when the chart moves to another. */
  const markRef = useRef<{ symbol: string; mark: TimelineMark } | null>(null);
  const { theme } = useTheme();
  const modeRef = useRef(theme.baseMode);
  modeRef.current = theme.baseMode;
  const [ready, setReady] = useState(false);

  useImperativeHandle(
    ref,
    () => ({
      setSymbol: (symbol) => {
        if (wsRef.current) wsRef.current.chart.setMarket({ symbol: chartSymbol(symbol) });
        else pendingSymbolRef.current = symbol;
      },
      showEvent: (event) => {
        if (wsRef.current) {
          const mark = showStudyEvent(wsRef.current.chart, event, chartSymbol);
          markRef.current = mark ? { symbol: event.symbol, mark } : null;
        } else {
          pendingSymbolRef.current = event.symbol;
          pendingEventRef.current = event;
        }
      },
      getState: () => wsRef.current?.getState() ?? null,
      getMarket: () => {
        const m = wsRef.current?.chart.market;
        return m ? { symbol: m.symbol ?? '', timeframe: m.timeframe ?? '' } : null;
      },
      setTimeframe: (timeframe) => {
        if (wsRef.current) void wsRef.current.chart.setMarket({ timeframe });
      },
      addIndicator: async (name) => {
        const chart = wsRef.current?.chart;
        if (!chart) return { ok: false, message: 'No chart is open.' };
        const wanted = name.trim().toLowerCase();
        const catalog = await chart.availableNativeIndicators();
        const match = catalog.find((c) => c.title.toLowerCase() === wanted || c.type.toLowerCase() === wanted);
        if (!match) return { ok: false, message: `“${name}” isn’t a built-in indicator.` };
        if (!match.supported) return { ok: false, message: `${match.title} doesn’t support this chart’s symbol.` };
        chart.addNativeIndicator(match.type);
        return { ok: true, message: `Added ${match.title}.` };
      },
      removeIndicator: async (name) => {
        const chart = wsRef.current?.chart;
        if (!chart) return { ok: false, message: 'No chart is open.' };
        const wanted = name.trim().toLowerCase();
        const handle = chart.indicators().find((h) => h.title.toLowerCase() === wanted || h.nativeType?.toLowerCase() === wanted);
        if (!handle) return { ok: false, message: `“${name}” isn’t on this chart.` };
        handle.remove();
        return { ok: true, message: `Removed ${handle.title}.` };
      },
    }),
    [],
  );

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    // A background tab is `display:none`, so its container has no size and
    // Vela can't be built into it. Construction waits for the first real size
    // (i.e. until the tab is first shown); after that, resizes are forwarded.
    const resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width === 0 || rect.height === 0) return;
      if (!wsRef.current) {
        const ws = new VelaWorkspace(container, {
          layout: '1', // starts as one chart; the toolbar's layout button offers grids up to 4×4
          symbol: chartSymbol(pendingSymbolRef.current ?? initialSymbol),
          timeframe: 'D',
          theme: theme.baseMode,
          live: true,
          providers: providerFactories,
          // The Pine scripts that ship with the app (pine/indicators): listed in the Indicators
          // dialog, not added to a chart until the user picks one.
          indicators: BUNDLED_MANIFEST,
        });
        // Must run AFTER construction: Vela's constructor re-registers its
        // built-in moving-average descriptors on every `new VelaWorkspace`,
        // which would silently undo this if it ran any earlier (see
        // thinMovingAverages.ts).
        installThinMovingAverages();
        // Before the first load can finish, so its `history:complete` is seen.
        watchAllCells(ws, watchedRef.current);
        // Daily-and-up bars are stamped at local midnight and intraday bars are
        // real instants, so the axis has to read in local time for both to
        // show the right date. (Vela defaults to UTC.) A restored layout
        // carries the timezone it was saved with and keeps it.
        if (!initialState && LOCAL_TIMEZONE) {
          try {
            ws.setTimezone(LOCAL_TIMEZONE);
          } catch {
            // Unknown zone name: stay on Vela's default rather than fail the chart.
          }
        }
        if (initialState) {
          ws.applyState(withChartSymbols(initialState));
          // The restored state carries its own market; a symbol picked in the
          // meantime is the more recent intent.
          if (pendingSymbolRef.current) ws.chart.setMarket({ symbol: chartSymbol(pendingSymbolRef.current) });
        }
        if (pendingEventRef.current) {
          const mark = showStudyEvent(ws.chart, pendingEventRef.current, chartSymbol);
          markRef.current = mark ? { symbol: pendingEventRef.current.symbol, mark } : null;
          pendingEventRef.current = null;
        }
        applyGridOpacity(ws, theme.baseMode);
        tintAttribution(ws);
        wsRef.current = ws;
        onWorkspaceRef.current?.(ws);
        setReady(true);
      } else {
        wsRef.current.resize();
      }
    });
    resizeObserver.observe(container);

    const watched = watchedRef.current;
    return () => {
      resizeObserver.disconnect();
      watched.forEach((stop) => stop());
      watched.clear();
      wsRef.current?.destroy();
      wsRef.current = null;
      onWorkspaceRef.current?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready || !wsRef.current) return;
    applyTheme(wsRef.current, theme.baseMode);
  }, [ready, theme.baseMode]);

  // The tab follows whichever chart of the grid is active. Cells come and go
  // with layout changes (and Vela may rebuild them), so the subscription is
  // re-pointed at the active chart after each one, and new cells get the same
  // grid-line treatment as the first.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ready || !ws) return;
    let unfollow = () => {};
    const follow = () => {
      unfollow();
      unfollow = ws.chart.on('market:changed', ({ symbol }) => {
        const normalized = normalizeSymbol(symbol);
        // A Study event's mark belongs to its stock: supplied again once its market lands, and not
        // carried over to the next stock's chart.
        const marked = markRef.current;
        if (marked) {
          const same = marked.symbol === normalized;
          setEventMark(ws.chart, same ? marked.mark : null);
          if (!same) markRef.current = null;
        }
        onSymbolChangeRef.current(normalized);
      });
      applyGridOpacity(ws, modeRef.current);
      watchAllCells(ws, watchedRef.current);
      tintAttribution(ws);
      if (ws.active.symbol) onSymbolChangeRef.current(normalizeSymbol(ws.active.symbol));
    };
    // Growth is judged only once a layout change has settled: crossing Vela's
    // WebGL budget (more than 8 charts) rebuilds every cell, so the count dips
    // on the way and `cell:created` alone would read that as a fresh grid.
    const trackGridSize = () => {
      const cells = ws.cells().length;
      if (cellCountRef.current === 1 && cells > 1) onGridGrowRef.current?.();
      cellCountRef.current = cells;
    };
    const stops = [
      ws.on('cell:active', follow),
      ws.on('cell:created', follow),
      ws.on('layout:changed', () => {
        follow();
        trackGridSize();
      }),
    ];
    follow();
    cellCountRef.current = ws.cells().length;
    return () => {
      unfollow();
      stops.forEach((stop) => stop());
    };
  }, [ready]);

  return <div ref={containerRef} className="single-chart-canvas" />;
});
