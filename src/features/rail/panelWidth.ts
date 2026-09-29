/** How wide the side panel (watchlist, alerts, Ask AI) is. The person drags its edge; the width is
 *  kept in the `side_panel_width` preference. Pure. */

export const PREF_PANEL_WIDTH = 'side_panel_width';
export const DEFAULT_PANEL_WIDTH = 300;
export const MIN_PANEL_WIDTH = 240;
export const MAX_PANEL_WIDTH = 720;
/** The chart always keeps at least this much of the window. */
const MIN_CHART_WIDTH = 360;

/** A width the panel can take in a window `windowWidth` wide: never narrower than its minimum,
 *  never so wide that the chart is squeezed out. */
export function clampPanelWidth(width: number, windowWidth: number): number {
  if (!Number.isFinite(width)) return DEFAULT_PANEL_WIDTH;
  const max = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, windowWidth - MIN_CHART_WIDTH));
  return Math.round(Math.min(max, Math.max(MIN_PANEL_WIDTH, width)));
}

/** The stored preference as a width, or the default. */
export function parsePanelWidth(raw: string | null | undefined): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : DEFAULT_PANEL_WIDTH;
}

/** The width while dragging: the panel sits at the window's right, so moving left widens it. */
export function dragWidth(startWidth: number, startX: number, x: number, windowWidth: number): number {
  return clampPanelWidth(startWidth + (startX - x), windowWidth);
}
