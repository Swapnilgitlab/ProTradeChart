import { describe, expect, it } from 'vitest';
import {
  activeChartIndex,
  activeChartTab,
  canCloseTab,
  chartTabs,
  homeTab,
  pythonTab,
  studiesTab,
  workspaceTabs,
  tabAfterClosing,
  tabAfterStep,
  type Tab,
} from './tabs';

const chart = (id: string, symbol = `india:NSE:${id.toUpperCase()}`): Tab => ({ kind: 'chart', id, symbol });
const python = (id = 'py'): Tab => ({ kind: 'python', id });
const studies = (id = 'st'): Tab => ({ kind: 'studies', id });
const home = (id = 'home'): Tab => ({ kind: 'home', id });

describe('picking the tabs apart', () => {
  it('finds the charts and the python tab', () => {
    const tabs = [chart('a'), python(), chart('b')];
    expect(chartTabs(tabs).map((t) => t.id)).toEqual(['a', 'b']);
    expect(pythonTab(tabs)?.id).toBe('py');
    expect(pythonTab([chart('a')])).toBeUndefined();
  });

  it('finds the home tab, another workspace like Python', () => {
    const tabs = [chart('a'), home()];
    expect(homeTab(tabs)?.id).toBe('home');
    expect(workspaceTabs(tabs).map((t) => t.id)).toEqual(['home']);
    expect(canCloseTab(tabs, 'home')).toBe(true);
  });
});

describe('the chart the shared chrome follows', () => {
  it('is the active tab when that is a chart', () => {
    const tabs = [chart('a'), chart('b')];
    expect(activeChartTab(tabs, 'b', null)?.id).toBe('b');
  });

  it('stays on the last chart while python is showing, so the watchlist does not jump', () => {
    const tabs = [chart('a'), chart('b'), python()];
    expect(activeChartTab(tabs, 'py', 'b')?.id).toBe('b');
  });

  it('falls back to the first chart when the remembered one has been closed', () => {
    const tabs = [chart('a'), python()];
    expect(activeChartTab(tabs, 'py', 'gone')?.id).toBe('a');
    expect(activeChartTab(tabs, 'py', null)?.id).toBe('a');
  });

  it('is nothing when there are no charts at all', () => {
    expect(activeChartTab([python()], 'py', null)).toBeNull();
    expect(activeChartTab([], 'py', null)).toBeNull();
  });
});

describe('what may be closed', () => {
  it('treats the Studies tab as a workspace like Python', () => {
    const tabs = [chart('a'), python(), studies()];
    expect(studiesTab(tabs)?.id).toBe('st');
    expect(workspaceTabs(tabs).map((t) => t.id)).toEqual(['py', 'st']);
    expect(canCloseTab(tabs, 'st')).toBe(true);
    expect(activeChartTab(tabs, 'st', 'a')?.id).toBe('a');
  });

  it('always lets the python tab go', () => {
    expect(canCloseTab([chart('a'), python()], 'py')).toBe(true);
  });

  it('keeps the last chart, because the rest of the app needs one', () => {
    expect(canCloseTab([chart('a'), python()], 'a')).toBe(false);
    expect(canCloseTab([chart('a')], 'a')).toBe(false);
    expect(canCloseTab([chart('a'), chart('b')], 'a')).toBe(true);
  });

  it('says no to a tab that is not there', () => {
    expect(canCloseTab([chart('a')], 'nope')).toBe(false);
  });
});

describe('which tab shows after one is closed', () => {
  it('is the one to its left, or the one that took its place', () => {
    const tabs = [chart('a'), chart('b'), chart('c')];
    expect(tabAfterClosing(tabs, 'b')).toBe('a');
    expect(tabAfterClosing(tabs, 'a')).toBe('b');
    expect(tabAfterClosing(tabs, 'c')).toBe('b');
  });

  it('is nothing when the last one goes, or when it was never there', () => {
    expect(tabAfterClosing([chart('a')], 'a')).toBeNull();
    expect(tabAfterClosing([chart('a')], 'nope')).toBeNull();
  });
});

describe('stepping between tabs', () => {
  it('wraps at either end', () => {
    const tabs = [chart('a'), python(), chart('b')];
    expect(tabAfterStep(tabs, 'a', 1)).toBe('py');
    expect(tabAfterStep(tabs, 'b', 1)).toBe('a');
    expect(tabAfterStep(tabs, 'a', -1)).toBe('b');
  });

  it('copes with an active tab that is gone', () => {
    expect(tabAfterStep([chart('a')], 'gone', 1)).toBe('a');
  });
});

describe('what a layout records as its active tab', () => {
  it('is the position among the charts, not among all the tabs', () => {
    const tabs = [python(), chart('a'), chart('b')];
    expect(activeChartIndex(tabs, 'b', null)).toBe(1);
    expect(activeChartIndex(tabs, 'a', null)).toBe(0);
  });

  it('is the last chart when python is the active tab', () => {
    const tabs = [chart('a'), chart('b'), python()];
    expect(activeChartIndex(tabs, 'py', 'b')).toBe(1);
    expect(activeChartIndex(tabs, 'py', null)).toBe(0);
  });

  it('is zero when there is no chart to point at', () => {
    expect(activeChartIndex([python()], 'py', null)).toBe(0);
  });
});
