import { listen } from '@tauri-apps/api/event';
import { VelaWorkspace, type WorkspaceState } from '@luxalgo/vela/workspace';
import { providerFactories } from '../data/providers';
import { firstChartOf } from '../features/layouts/layoutDocument';
import { errorMessage, getChartLayouts, scriptScreenshotResult, type ScreenshotRequest } from '../lib/ipc';
import { chartSymbol } from '../lib/symbols';
import { applyGridOpacity, LOCAL_TIMEZONE, tintAttribution } from './ChartView';
import { keepStatuslineReadable } from './statuslineInk';
import { tidyStatusline } from './statuslineMeta';
import { watchSymbolDrawings } from './symbolDrawings';
import { installThinMovingAverages } from './thinMovingAverages';

/** Charts drawn for scripts (`pt.screenshot`). Python can't draw the app's charts, so the backend asks
 *  the main window: each request builds one chart in a sized box off screen (a `display:none` box
 *  can't hold one), waits for its history to load and settle, and hands the PNG back. Run in the main
 *  window only, like the alert engine, so a request is drawn once. */

/** How long a chart may take to load, and how long it is given after that for indicators and
 *  drawings to land. */
const LOAD_LIMIT_MS = 60_000;
const SETTLE_MS = 1_500;

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

async function draw(request: ScreenshotRequest, mode: 'light' | 'dark'): Promise<string> {
  let state: WorkspaceState | null = null;
  if (request.layout) {
    const wanted = request.layout.trim().toLowerCase();
    const row = (await getChartLayouts()).find((l) => l.name.trim().toLowerCase() === wanted);
    if (!row) throw new Error(`There is no saved layout called "${request.layout}".`);
    state = firstChartOf(row.stateJson, request.symbol, request.timeframe);
    if (!state) throw new Error(`The layout "${request.layout}" has no chart.`);
  }
  const box = document.createElement('div');
  box.setAttribute('aria-hidden', 'true');
  Object.assign(box.style, {
    position: 'fixed',
    left: '-20000px',
    top: '0',
    width: `${request.width}px`,
    height: `${request.height}px`,
    pointerEvents: 'none',
  });
  document.body.appendChild(box);
  let ws: VelaWorkspace | null = null;
  const stops: (() => void)[] = [];
  try {
    ws = new VelaWorkspace(box, {
      layout: '1',
      symbol: chartSymbol(request.symbol),
      timeframe: request.timeframe,
      theme: mode,
      live: false,
      providers: providerFactories,
      drawingToolbar: false,
    });
    installThinMovingAverages();
    try {
      ws.setTimezone(LOCAL_TIMEZONE);
    } catch {
      // Unknown zone name: Vela's default.
    }
    const chart = ws.chart;
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('The chart’s prices didn’t load within a minute.')), LOAD_LIMIT_MS);
      const off = chart.on('history:complete', ({ barsLoaded }) => {
        window.clearTimeout(timer);
        off();
        if (barsLoaded > 0) resolve();
        else reject(new Error(`There are no prices for ${request.symbol} at ${request.timeframe}.`));
      });
    });
    if (state) ws.applyState(state);
    // The chart reads as it does in the app: the symbol's drawings, the tidied status line.
    stops.push(watchSymbolDrawings(ws.chart));
    for (const cell of ws.cells()) stops.push(tidyStatusline(cell), keepStatuslineReadable(cell));
    applyGridOpacity(ws, mode);
    tintAttribution(ws);
    await loaded;
    await wait(SETTLE_MS);
    const url = ws.screenshot();
    if (!url) throw new Error('The chart couldn’t be drawn.');
    return url.slice(url.indexOf(',') + 1);
  } finally {
    stops.forEach((stop) => stop());
    ws?.destroy();
    box.remove();
  }
}

/** Starts answering screenshot requests. Returns a function that stops. */
export function startScriptScreenshots(themeMode: () => 'light' | 'dark'): () => void {
  let queue = Promise.resolve();
  let stopped = false;
  let off: (() => void) | null = null;
  void listen<ScreenshotRequest>('script-screenshot', ({ payload }) => {
    if (stopped) return;
    queue = queue.then(async () => {
      try {
        await scriptScreenshotResult(payload.requestId, await draw(payload, themeMode()), null);
      } catch (err) {
        await scriptScreenshotResult(payload.requestId, null, err instanceof Error ? err.message : errorMessage(err)).catch(() => {});
      }
    });
  }).then((stop) => {
    if (stopped) stop();
    else off = stop;
  });
  return () => {
    stopped = true;
    off?.();
  };
}
