/** The tab set: chart tabs, and the Python, Studies and Screener workspaces when they are open.
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
  /** Bumped to rebuild the tab's charts from `initialState`: when another broker starts serving
   *  `india:` symbols, so they load and stream through it. */
  rebuilds?: number;
}

/** The Home tab: a landing page linking to every other part of the app. At most one is open. */
export interface HomeTab {
  kind: 'home';
  id: string;
}

/** The Python workspace: scripts, an editor, a console and results. At most one is open. */
export interface PythonTab {
  kind: 'python';
  id: string;
}

/** The Studies workspace: build, run and read Studies. At most one is open. */
export interface StudiesTab {
  kind: 'studies';
  id: string;
}

/** The Script Editor: write Pine Script and add it to the last chart shown. At most one is open. */
export interface PineTab {
  kind: 'pine';
  id: string;
}

/** The Screener workspace: build, save and run screens. At most one is open. */
export interface ScreenerTab {
  kind: 'screener';
  id: string;
}

/** A tab that isn't a chart: a workspace with no symbol of its own. */
export type WorkspaceTab = HomeTab | PineTab | PythonTab | StudiesTab | ScreenerTab;

/** What a workspace tab is called, in the tab bar and wherever else it is named. */
export const WORKSPACE_LABELS: Record<WorkspaceTab['kind'], string> = {
  home: 'Home',
  pine: 'Script Editor',
  python: 'Python',
  studies: 'Studies',
  screener: 'Screener',
};

export type Tab = ChartTab | WorkspaceTab;

export const isChartTab = (tab: Tab): tab is ChartTab => tab.kind === 'chart';

export const chartTabs = (tabs: readonly Tab[]): ChartTab[] => tabs.filter(isChartTab);

export const homeTab = (tabs: readonly Tab[]): HomeTab | undefined =>
  tabs.find((t): t is HomeTab => t.kind === 'home');

export const pineTab = (tabs: readonly Tab[]): PineTab | undefined => tabs.find((t): t is PineTab => t.kind === 'pine');

export const pythonTab = (tabs: readonly Tab[]): PythonTab | undefined =>
  tabs.find((t): t is PythonTab => t.kind === 'python');

export const studiesTab = (tabs: readonly Tab[]): StudiesTab | undefined =>
  tabs.find((t): t is StudiesTab => t.kind === 'studies');

export const screenerTab = (tabs: readonly Tab[]): ScreenerTab | undefined =>
  tabs.find((t): t is ScreenerTab => t.kind === 'screener');

/** The open workspaces, in tab order: what a loaded layout leaves in place beside its charts. */
export const workspaceTabs = (tabs: readonly Tab[]): WorkspaceTab[] => tabs.filter((t): t is WorkspaceTab => !isChartTab(t));

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

/** Whether this tab may be closed. A workspace (Python, Studies, Screener) always can; a chart only while it isn't the last one,
 *  because the watchlist, the alerts and the Pine dock all need a chart to talk about. */
export function canCloseTab(tabs: readonly Tab[], id: string): boolean {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return false;
  return !isChartTab(tab) || chartTabs(tabs).length > 1;
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
