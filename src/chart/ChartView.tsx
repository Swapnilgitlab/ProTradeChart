import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { VelaWorkspace, type WorkspaceState } from '@luxalgo/vela/workspace';
import { providerFactories } from '../data/providers';
import { normalizeSymbol } from '../lib/symbols';
import { BUNDLED_MANIFEST } from '../pine/bundled';
import { useTheme } from '../theme/ThemeProvider';
import { trackCursorPrice } from './alertActions';
import { watchHistory } from './historyBackfill';
import { installThinMovingAverages } from './thinMovingAverages';
import { showCompanyName } from './watermarkName';

// Vela's own default grid hues, at 20% opacity — the same neutral gray it
// already picks per light/dark, only more subtle. `setTheme()` re-skins the
// chart from the theme's own solid gridColor, so this needs reapplying after
// every theme switch, and for every cell of the grid — including ones a later
// layout change brings in — not just the first chart at construction.
const GRID_COLOR = { light: 'rgba(204, 204, 204, 0.2)', dark: 'rgba(32, 34, 44, 0.2)' } as const;

function applyGridOpacity(ws: VelaWorkspace, baseMode: 'light' | 'dark') {
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

/** Starts watching every chart of `ws` that isn't already: loading older
 *  history as the user scrolls or zooms back (see historyBackfill.ts),
 *  remembering the price under the cursor for "add alert here", and putting the
 *  company name under the symbol watermark (see watermarkName.ts).
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
      const stops = [watchHistory(chart), trackCursorPrice(chart), showCompanyName(cell)];
      watched.set(chart, () => stops.forEach((stop) => stop()));
    }
  }
}

/** The machine's IANA timezone, e.g. `Asia/Kolkata`. */
const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export interface ChartViewHandle {
  /** Points the tab's active chart at a new `provider:TICKER` symbol. */
  setSymbol: (symbol: string) => void;
  /** Every chart in the tab's grid — layout, timeframes, indicators, drawings,
   *  renderer config — for saving as part of a layout. Not just the symbol. */
  getState: () => WorkspaceState | null;
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
  const { theme } = useTheme();
  const modeRef = useRef(theme.baseMode);
  modeRef.current = theme.baseMode;
  const [ready, setReady] = useState(false);

  useImperativeHandle(
    ref,
    () => ({
      setSymbol: (symbol) => {
        if (wsRef.current) wsRef.current.chart.setMarket({ symbol });
        else pendingSymbolRef.current = symbol;
      },
      getState: () => wsRef.current?.getState() ?? null,
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
          symbol: pendingSymbolRef.current ?? initialSymbol,
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
          ws.applyState(initialState);
          // The restored state carries its own market; a symbol picked in the
          // meantime is the more recent intent.
          if (pendingSymbolRef.current) ws.chart.setMarket({ symbol: pendingSymbolRef.current });
        }
        applyGridOpacity(ws, theme.baseMode);
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
    wsRef.current.setTheme(theme.baseMode);
    applyGridOpacity(wsRef.current, theme.baseMode);
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
      unfollow = ws.chart.on('market:changed', ({ symbol }) => onSymbolChangeRef.current(normalizeSymbol(symbol)));
      applyGridOpacity(ws, modeRef.current);
      watchAllCells(ws, watchedRef.current);
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
