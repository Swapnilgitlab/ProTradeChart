/** Which panel the right rail is showing, and how that is remembered between launches. Pure, so the
 *  migration from the old "watchlist collapsed" setting is tested without a component. */

export const RAIL_PANELS = ['watchlist', 'alerts', 'assistant'] as const;
export type RailPanelId = (typeof RAIL_PANELS)[number];

/** The preference that remembers the panel. `none` means the rail is showing no panel. */
export const PREF_RAIL_PANEL = 'right_panel';
/** What remembered the watchlist being folded away, before the rail existed. */
export const PREF_LEGACY_WATCHLIST_COLLAPSED = 'watchlist_collapsed';

const isRailPanel = (value: string): value is RailPanelId => (RAIL_PANELS as readonly string[]).includes(value);

/** The panel to start with, from what was saved. A launch that has never saved one follows the old setting:
 *  the watchlist was the only panel, open unless it had been folded away. */
export function restoreRailPanel(saved: string | null, legacyCollapsed: string | null): RailPanelId | null {
  if (saved === 'none') return null;
  if (saved !== null && isRailPanel(saved)) return saved;
  return legacyCollapsed === '1' ? null : 'watchlist';
}

export const railPreferenceValue = (panel: RailPanelId | null): string => panel ?? 'none';

/** What pressing a rail button leaves showing: its own panel, or nothing when it was already the one. */
export const panelAfterToggle = (current: RailPanelId | null, pressed: RailPanelId): RailPanelId | null =>
  current === pressed ? null : pressed;
