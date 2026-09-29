import type { WorkspaceState } from '@luxalgo/vela/workspace';
import { isThemeBackground } from '../../chart/canvasBackground';
import { chartSymbol, isSupportedSymbol, normalizeSymbol } from '../../lib/symbols';

/** What one saved layout's `stateJson` deserializes to: the WHOLE session —
 *  every tab's symbol plus its full Vela state — not a single chart's settings.
 *
 *  A layout says nothing about the theme: the theme is an app-wide preference,
 *  so saving a layout never records it and loading one never changes it (see
 *  `withoutTheme` for the part of Vela's state that would otherwise carry it).
 *  The one exception is a canvas background someone chose for a chart: that
 *  belongs to the layout, and the theme only fills in where none was chosen
 *  (`chart/canvasBackground.ts`).
 *
 *  Versioned because it's hand-parsed JSON from local storage that a future
 *  format change could otherwise choke on. `state` is optional per tab: a tab
 *  that was never actually shown never built its chart (see ChartView), so it
 *  has no live state to read; saving still succeeds for it, with just the
 *  symbol. */
export interface LayoutDocument {
  version: 1;
  tabs: { symbol: string; state?: WorkspaceState }[];
  activeTabIndex: number;
}

/** The renderer settings that Vela's `setTheme()` owns — the chart's text, grid
 *  lines and borders (and its background, handled apart because one someone chose
 *  is kept) — as paths into a chart's `rendererConfig`.
 *  Vela writes them into its state, and restoring a state does NOT re-skin the
 *  chart afterwards (`setTheme` with the mode it is already in is a no-op), so
 *  a layout saved under the dark theme would turn a light-theme chart dark. */
const THEME_OWNED_SETTINGS: readonly (readonly string[])[] = [
  ['layout', 'textColor'],
  ['grid', 'vertLines', 'color'],
  ['grid', 'horzLines', 'color'],
  ['panes', 'separatorColor'],
  ['priceScale', 'borderColor'],
];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function omitPath(obj: Record<string, unknown>, [head, ...rest]: readonly string[]): Record<string, unknown> {
  if (!(head in obj)) return obj;
  if (rest.length === 0) {
    const copy = { ...obj };
    delete copy[head];
    return copy;
  }
  const child = obj[head];
  return isRecord(child) ? { ...obj, [head]: omitPath(child, rest) } : obj;
}

/** A chart's settings without its background when that is the theme's own. A background someone
 *  chose is kept: it belongs to the layout. */
function withoutThemeBackground(config: Record<string, unknown>): Record<string, unknown> {
  const layout = config.layout;
  return isRecord(layout) && 'background' in layout && isThemeBackground(layout.background) ? omitPath(config, ['layout', 'background']) : config;
}

/** `state` without the settings the theme owns, so restoring it leaves the
 *  chart in whatever theme the app is showing. Everything else — chart style,
 *  candle colours the user picked, a canvas background they picked,
 *  indicators, drawings — is kept. Returns a new object; the input is
 *  untouched. */
export function withoutTheme(state: WorkspaceState): WorkspaceState {
  if (!Array.isArray(state.charts)) return state;
  return {
    ...state,
    charts: state.charts.map((chart) =>
      isRecord(chart.rendererConfig)
        ? { ...chart, rendererConfig: withoutThemeBackground(THEME_OWNED_SETTINGS.reduce(omitPath, chart.rendererConfig)) }
        : chart,
    ),
  };
}

/** `state` with every chart's symbol in the form a chart is given (see `chartSymbol`), so a
 *  layout saved before that form existed shows `HFCL`, not `NSE:HFCL`, in the chart's title
 *  and status line. It loads the same instrument; nothing stored is rewritten. Returns the
 *  input itself when nothing needed changing. */
export function withChartSymbols(state: WorkspaceState): WorkspaceState {
  if (!Array.isArray(state.charts)) return state;
  let changed = false;
  const charts = state.charts.map((chart) => {
    if (typeof chart.symbol !== 'string') return chart;
    const symbol = chartSymbol(chart.symbol);
    if (symbol === chart.symbol) return chart;
    changed = true;
    return { ...chart, symbol };
  });
  return changed ? { ...state, charts } : state;
}

export function serializeLayout(doc: LayoutDocument): string {
  const tabs = doc.tabs.map(({ symbol, state }) => (state ? { symbol, state: withoutTheme(state) } : { symbol }));
  return JSON.stringify({ version: doc.version, tabs, activeTabIndex: doc.activeTabIndex });
}

/** Parses and validates a stored layout, returning `null` for anything that
 *  isn't a usable document — a corrupt row must never take the window down. */
export function parseLayout(json: string): LayoutDocument | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const doc = raw as Partial<LayoutDocument>;
  if (doc.version !== 1 || !Array.isArray(doc.tabs) || doc.tabs.length === 0) return null;

  const tabs: LayoutDocument['tabs'] = [];
  for (const tab of doc.tabs) {
    if (typeof tab !== 'object' || tab === null || typeof tab.symbol !== 'string' || tab.symbol.trim() === '') return null;
    // Older layouts may hold a bare ticker; normalise so it resolves to a provider.
    // They may also carry the theme they were saved under (a `themeKey`, and the
    // chart colours inside Vela's state); neither is honoured.
    tabs.push({ symbol: normalizeSymbol(tab.symbol), ...(tab.state ? { state: withoutTheme(tab.state) } : {}) });
  }

  const index = typeof doc.activeTabIndex === 'number' ? Math.trunc(doc.activeTabIndex) : 0;
  return { version: 1, tabs, activeTabIndex: Math.min(Math.max(index, 0), tabs.length - 1) };
}

/** A layout can hold symbols from a data source the app no longer has (Yahoo Finance was
 *  removed); they can't load, and would leave a chart blank with no explanation. Each tab —
 *  and each chart of its grid — holding one is moved to `fallback`. `replaced` counts the
 *  tabs changed, so the user can be told. Nothing stored is rewritten: this is applied to the
 *  layout being opened, and a saved layout keeps its old symbols until it is saved again. */
export function withoutUnsupportedSymbols(doc: LayoutDocument, fallback: string): { doc: LayoutDocument; replaced: number } {
  let replaced = 0;
  const tabs = doc.tabs.map((tab) => {
    let changed = !isSupportedSymbol(tab.symbol);
    let state = tab.state;
    if (state && Array.isArray(state.charts)) {
      const charts = state.charts.map((chart) => {
        if (typeof chart.symbol !== 'string' || isSupportedSymbol(normalizeSymbol(chart.symbol))) return chart;
        changed = true;
        const { provider: _venue, ...rest } = chart;
        return { ...rest, symbol: fallback };
      });
      state = { ...state, charts };
    }
    if (!changed) return tab;
    replaced++;
    return { symbol: !isSupportedSymbol(tab.symbol) ? fallback : tab.symbol, ...(state ? { state } : {}) };
  });
  return { doc: { ...doc, tabs }, replaced };
}
