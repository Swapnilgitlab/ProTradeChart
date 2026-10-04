import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarRange, ChevronLeft, ChevronRight, ExternalLink, LayoutGrid } from 'lucide-react';
import { layoutForGrid, VelaWorkspace } from '@luxalgo/vela/workspace';
import { applyGridOpacity, applyTheme, LOCAL_TIMEZONE, tintAttribution } from '../../chart/ChartView';
import { installThinMovingAverages } from '../../chart/thinMovingAverages';
import { providerFactories } from '../../data/providers';
import { getPreference, setPreference, type WatchlistFlag } from '../../lib/ipc';
import { chartSymbol, displayTicker } from '../../lib/symbols';
import {
  clampPage,
  gridById,
  GRIDS,
  pageCount,
  pageRange,
  pageSymbols,
  rangeById,
  RANGES,
  shapeFor,
  type GridId,
  type RangeId,
} from '../../screener/chartPages';
import { useTheme } from '../../theme/ThemeProvider';
import { ScreenFlag } from './ScreenFlag';

const PREF_GRID = 'screener_chart_grid';
const PREF_RANGE = 'screener_chart_range';
/** One identity per slot of the largest grid: a page's symbols go into them in order. */
const CELLS = ['s1', 's2', 's3', 's4'] as const;

interface Props {
  /** The matches, in the table's current order. */
  symbols: string[];
  names: Map<string, string | null>;
  /** The matches' flags (a symbol with none is absent), and how to set one. */
  flags: Record<string, WatchlistFlag>;
  onFlag: (symbol: string, flag: WatchlistFlag | null) => void;
  onOpenSymbol: (symbol: string) => void;
}

/** The matches as daily candlestick charts, a page of 1×1 to 2×2 at a time. One Vela workspace for the
 *  whole grid, built once and re-pointed as the page or grid changes; the bars come through the same
 *  providers as the chart tabs (from the market-data store where it holds them). */
export function ScreenCharts({ symbols, names, flags, onFlag, onOpenSymbol }: Props) {
  const [gridId, setGridId] = useState<GridId>('2x2');
  const [page, setPage] = useState(0);
  const [range, setRange] = useState<RangeId>('1Y');
  /** The symbol and range each cell was last pointed at, so a page or range change reloads only what changed. */
  const shownRef = useRef(new Map<string, string>());
  const grid = gridById(gridId);
  const total = symbols.length;
  const current = useMemo(() => pageSymbols(symbols, clampPage(page, total, grid), grid), [symbols, page, total, grid]);
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<VelaWorkspace | null>(null);
  const [ready, setReady] = useState(false);
  const { theme } = useTheme();
  const modeRef = useRef(theme.baseMode);
  modeRef.current = theme.baseMode;
  const firstRef = useRef(current);
  firstRef.current = current;
  const rangeRef = useRef(range);
  rangeRef.current = range;

  useEffect(() => {
    getPreference(PREF_GRID)
      .then((raw) => raw && setGridId(gridById(raw).id))
      .catch(() => {});
    getPreference(PREF_RANGE)
      .then((raw) => raw && setRange(rangeById(raw)))
      .catch(() => {});
  }, []);
  const pickGrid = (id: GridId) => {
    setGridId(id);
    setPreference(PREF_GRID, id).catch(() => {});
  };
  const pickRange = (id: RangeId) => {
    setRange(id);
    setPreference(PREF_RANGE, id).catch(() => {});
  };

  // A new result starts from its first page.
  useEffect(() => setPage(0), [symbols]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width === 0 || rect.height === 0) return;
      if (wsRef.current) {
        wsRef.current.resize();
        return;
      }
      const first = firstRef.current;
      const seeds = CELLS.map((id, i) => [id, { symbol: chartSymbol(first[i] ?? first[0] ?? ''), visibleRange: rangeRef.current }] as const);
      for (const [id, seed] of seeds) shownRef.current.set(id, `${seed.symbol}|${seed.visibleRange}`);
      const ws = new VelaWorkspace(container, {
        layout: '1',
        cells: Object.fromEntries(seeds),
        timeframe: 'D',
        theme: modeRef.current,
        live: false,
        providers: providerFactories,
        drawingToolbar: false,
        bottombar: false,
        topbar: { left: ['timeframes'], right: [] },
        indicatorPicker: false,
      });
      // Vela re-registers its own moving averages on every construction (see thinMovingAverages.ts).
      installThinMovingAverages();
      try {
        ws.setTimezone(LOCAL_TIMEZONE);
      } catch {
        // Unknown zone name: stay on Vela's default.
      }
      applyGridOpacity(ws, modeRef.current);
      tintAttribution(ws);
      wsRef.current = ws;
      setReady(true);
    });
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      wsRef.current?.destroy();
      wsRef.current = null;
      shownRef.current.clear();
    };
  }, []);

  // Point the grid at the page: its shape, then each cell's symbol and range (cells a smaller grid
  // pooled come back with whatever they last showed, so every visible one is checked again). The range
  // goes with the symbol so Vela loads that much history in one pass; the cell's interval is kept.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ready || !ws || current.length === 0) return;
    const shape = shapeFor(grid, current.length);
    ws.setLayout(layoutForGrid(shape.rows, shape.cols));
    current.forEach((symbol, i) => {
      const cell = ws.cell(CELLS[i]);
      if (!cell) return;
      const want = `${chartSymbol(symbol)}|${range}`;
      if (cell.chart.market?.symbol === chartSymbol(symbol) && shownRef.current.get(CELLS[i]) === want) return;
      shownRef.current.set(CELLS[i], want);
      void cell.chart.setMarket({ symbol: chartSymbol(symbol), visibleRange: range });
    });
    applyGridOpacity(ws, modeRef.current);
    tintAttribution(ws);
  }, [ready, current, grid, range]);

  useEffect(() => {
    if (ready && wsRef.current) applyTheme(wsRef.current, theme.baseMode);
  }, [ready, theme.baseMode]);

  const pages = pageCount(total, grid);
  const shown = clampPage(page, total, grid);

  return (
    <div className="screener-charts">
      <div className="screener-charts-bar">
        <span className="screener-chip screener-chip-static" role="group" aria-label="Grid">
          <LayoutGrid size={13} aria-hidden="true" />
          {GRIDS.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`screener-exchange${g.id === gridId ? ' on' : ''}`}
              aria-pressed={g.id === gridId}
              onClick={() => pickGrid(g.id)}
            >
              {g.label}
            </button>
          ))}
        </span>
        <span className="screener-chip screener-chip-static" role="group" aria-label="Range" title="How much history each chart shows">
          <CalendarRange size={13} aria-hidden="true" />
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`screener-exchange${r.id === range ? ' on' : ''}`}
              aria-pressed={r.id === range}
              onClick={() => pickRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </span>
        <div className="screener-charts-open">
          {current.map((symbol) => (
            <span key={symbol} className="screener-charts-symbol">
              <ScreenFlag symbol={symbol} flag={flags[symbol] ?? null} onFlag={(flag) => onFlag(symbol, flag)} />
              <button
                type="button"
                className="btn btn-tiny"
                title={`Open ${names.get(symbol) ?? displayTicker(symbol)} in a chart tab`}
                onClick={() => onOpenSymbol(symbol)}
              >
                {displayTicker(symbol)}
                <ExternalLink size={11} />
              </button>
            </span>
          ))}
        </div>
        <div className="pine-toolbar-spacer" />
        <span className="muted small">{pageRange(shown, total, grid)}</span>
        <button type="button" className="icon-button" aria-label="Previous page" disabled={shown === 0} onClick={() => setPage(shown - 1)}>
          <ChevronLeft size={15} />
        </button>
        <button type="button" className="icon-button" aria-label="Next page" disabled={shown >= pages - 1} onClick={() => setPage(shown + 1)}>
          <ChevronRight size={15} />
        </button>
      </div>
      <div ref={containerRef} className="screener-charts-grid" />
    </div>
  );
}
