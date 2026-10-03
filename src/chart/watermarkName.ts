import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { getSymbolNames } from '../lib/ipc';
import { normalizeSymbol, splitSymbol } from '../lib/symbols';

type Cell = ReturnType<VelaWorkspace['cells']>[number];

/** Names found this session, shared by every chart and tab. */
const found = new Map<string, string>();

/** Only the brokers' instrument lists carry company names; a crypto pair or an imported
 *  file has none, so asking the backend about one would be a wasted round trip. */
const HAS_NAMES = new Set(['zerodha']);

/** The company name for `symbol`, or null if none is known. */
export async function companyName(symbol: string): Promise<string | null> {
  const hit = found.get(symbol);
  if (hit) return hit;
  if (!HAS_NAMES.has(splitSymbol(symbol).provider)) return null;
  try {
    const names = await getSymbolNames([symbol]);
    for (const [s, name] of Object.entries(names ?? {})) found.set(s, name);
  } catch {
    // No name is only a missing caption.
  }
  return found.get(symbol) ?? null;
}

/** Puts the company name beneath a cell's symbol watermark ("INFY · 1D", then
 *  "Infosys Limited"). Vela draws that mark as its own ticker-only text; the line
 *  is added inside the same element rather than drawn separately, so it keeps
 *  everything Vela does for the mark — the per-chart show/hide setting, hiding
 *  while bars load, the plot-derived colour, and appearing in screenshots.
 *  Returns a function that removes it. */
export function showCompanyName(cell: Cell): () => void {
  let line: HTMLElement | null = null;
  let current = '';
  let stopped = false;

  const render = (name: string | null) => {
    const mark = cell.host.querySelector<HTMLElement>('.vela-watermark');
    if (!name || !mark) {
      line?.remove();
      line = null;
      return;
    }
    if (!line || line.parentElement !== mark) {
      line?.remove();
      line = mark.ownerDocument.createElement('span');
      line.className = 'watermark-name';
      mark.appendChild(line);
      // The mark is a centred row holding one line of text; this stacks the name under it.
      mark.style.flexDirection = 'column';
    }
    line.textContent = name;
  };

  const refresh = async () => {
    const symbol = normalizeSymbol(cell.symbol);
    current = symbol;
    // A new symbol never keeps the last one's name, even for a moment.
    render(found.get(symbol) ?? null);
    const name = await companyName(symbol);
    if (!stopped && current === symbol) render(name);
  };

  const chart = cell.chart;
  const stops = [
    chart.on('market:changed', () => void refresh()),
    chart.on('load:end', () => void refresh()),
  ];
  void refresh();
  return () => {
    stopped = true;
    stops.forEach((stop) => stop());
    line?.remove();
  };
}
