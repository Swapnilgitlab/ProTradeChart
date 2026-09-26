/** The tab set: chart tabs, and the Python workspace when it is open.
 *
 *  Pure, so the rules that are easy to get wrong — which chart the shared chrome follows while
 *  Python is showing, what a layout saves, what may be closed — are tested without a component. */

import type { WorkspaceState } from '@luxalgo/vela/workspace';

export interface ChartTab {
  kind: 'chart';
  id: string;
  /** Fully-qualified `provider:TICKER`. Tracks the chart's own symbol. */
  symbol: string;
  /** Only set when this tab was just restored from a saved layout — consumed
   *  once by ChartView at construction. */
  initialState?: WorkspaceState;
}

/** The Python workspace: scripts, an editor, a console and results. At most one is open. */
export interface PythonTab {
  kind: 'python';
  id: string;
}

export type Tab = ChartTab | PythonTab;

export const isChartTab = (tab: Tab): tab is ChartTab => tab.kind === 'chart';

export const chartTabs = (tabs: readonly Tab[]): ChartTab[] => tabs.filter(isChartTab);

export const pythonTab = (tabs: readonly Tab[]): PythonTab | undefined =>
  tabs.find((t): t is PythonTab => t.kind === 'python');

/** The chart the shared chrome follows — the watchlist's highlight, the Pine dock, a new alert's
 *  symbol — and the one a picked symbol loads into.
 *
 *  It is the active tab when that is a chart. While the Python tab is showing it is the chart
 *  that was last active, so the watchlist doesn't jump to another symbol just because you opened
 *  Python. `lastChartId` may name a tab that has since been closed, which is why it is checked. */
export function activeChartTab(tabs: readonly Tab[], activeTabId: string, lastChartId: string | null): ChartTab | null {
  const active = tabs.find((t) => t.id === activeTabId);
  if (active && isChartTab(active)) return active;
  const remembered = tabs.find((t) => t.id === lastChartId);
  if (remembered && isChartTab(remembered)) return remembered;
  return chartTabs(tabs)[0] ?? null;
}

/** Whether this tab may be closed. Python always can; a chart only while it isn't the last one,
 *  because the watchlist, the alerts and the Pine dock all need a chart to talk about. */
export function canCloseTab(tabs: readonly Tab[], id: string): boolean {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return false;
  return tab.kind === 'python' || chartTabs(tabs).length > 1;
}

/** Which tab to show after `id` is closed: the one to its left, else the one that took its place. */
export function tabAfterClosing(tabs: readonly Tab[], id: string): string | null {
  const index = tabs.findIndex((t) => t.id === id);
  if (index === -1) return null;
  const left = tabs.filter((t) => t.id !== id);
  return (left[index - 1] ?? left[index] ?? left[0])?.id ?? null;
}

/** The next tab along, wrapping at either end. */
export function tabAfterStep(tabs: readonly Tab[], activeTabId: string, delta: number): string {
  const index = tabs.findIndex((t) => t.id === activeTabId);
  if (index === -1) return tabs[0]?.id ?? activeTabId;
  return tabs[(index + delta + tabs.length) % tabs.length].id;
}

/** Where the active chart sits among the chart tabs — what a layout records, since a layout holds
 *  charts only. Zero when the Python tab is the active one. */
export function activeChartIndex(tabs: readonly Tab[], activeTabId: string, lastChartId: string | null): number {
  const chart = activeChartTab(tabs, activeTabId, lastChartId);
  if (!chart) return 0;
  return Math.max(0, chartTabs(tabs).findIndex((t) => t.id === chart.id));
}
