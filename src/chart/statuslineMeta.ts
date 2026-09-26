import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { normalizeSymbol } from '../lib/symbols';

type Cell = ReturnType<VelaWorkspace['cells']>[number];

/** Vela's status line reads `HFCL · ZERODHA · 1D`: the symbol, then a small line naming
 *  the data source and the timeframe. The source is noise on every chart, but the
 *  timeframe is not — in a grid it is what tells the charts apart — so only the source
 *  is dropped: `· ZERODHA · 1D` becomes `· 1D`. Text with no source is left alone. */
export function withoutDataSource(text: string): string {
  const parts = text
    .split('·')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length >= 2 ? `· ${parts.slice(1).join(' · ')}` : text;
}

/** Cleans up a cell's status line: no data-source name, and the full symbol on hover so
 *  the source is still one mouse-over away. Vela rewrites that line on every symbol and
 *  timeframe change, so this watches it rather than editing it once; the rewrite it makes
 *  is a fixed point (a clean line is left as it is), so watching it cannot loop.
 *  Returns a function that stops watching. */
export function tidyStatusline(cell: Cell): () => void {
  let observer: MutationObserver | null = null;
  let watched: Element | null = null;
  let stopped = false;

  const apply = () => {
    if (stopped) return;
    const symbolEl = cell.host.querySelector<HTMLElement>('.vela-sl-symbol');
    const metaEl = cell.host.querySelector<HTMLElement>('.vela-sl-meta');
    if (symbolEl) symbolEl.title = normalizeSymbol(cell.symbol);
    if (!metaEl) return;
    const tidy = withoutDataSource(metaEl.textContent ?? '');
    if (tidy !== metaEl.textContent) metaEl.textContent = tidy;
    if (watched !== metaEl && typeof MutationObserver !== 'undefined') {
      observer?.disconnect();
      watched = metaEl;
      observer = new MutationObserver(apply);
      observer.observe(metaEl, { childList: true, characterData: true, subtree: true });
    }
  };

  const chart = cell.chart;
  const stops = [chart.on('market:changed', apply), chart.on('load:end', apply)];
  apply();
  return () => {
    stopped = true;
    observer?.disconnect();
    stops.forEach((stop) => stop());
  };
}
