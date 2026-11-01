import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';

const store = new Map<string, string>();
vi.mock('../lib/ipc', () => ({
  getPreference: async (key: string) => store.get(key) ?? null,
  setPreference: async (key: string, value: string) => void store.set(key, value),
}));

const { PREF_KEY, installToolPrefs, layered, parseToolPrefs, withTool } = await import('./drawingToolPrefs');

/** A chart's drawing tools as far as this module sees them: a remembered-settings map and a
 *  saved-styles map, and the events Vela fires for each tool that changes. */
function fakeChart(defaults: Record<string, unknown> = {}, templates: Record<string, unknown[]> = {}) {
  const handlers = new Map<string, ((e: { type: string }) => void)[]>();
  const state = { defaults: { ...defaults }, templates: { ...templates } };
  const fire = (event: string, type: string) => handlers.get(event)?.forEach((h) => h({ type }));
  const chart = {
    on: (event: string, h: (e: { type: string }) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((x) => x !== h));
    },
    drawings: {
      toolDefaults: () => ({ ...state.defaults }),
      toolTemplates: () => ({ ...state.templates }),
      setToolDefaults: vi.fn((map: Record<string, unknown>) => {
        const changed = new Set([...Object.keys(state.defaults), ...Object.keys(map)]);
        state.defaults = { ...map };
        changed.forEach((type) => fire('drawing:defaults', type));
      }),
      setToolTemplates: vi.fn((map: Record<string, unknown[]>) => {
        state.templates = { ...map };
      }),
    },
    /** What a user's edit in the settings panel does. */
    edit(type: string, value: unknown) {
      if (value === undefined) delete state.defaults[type];
      else state.defaults[type] = value;
      fire('drawing:defaults', type);
    },
  };
  return chart;
}

function fakeWorkspace(chart: ReturnType<typeof fakeChart>) {
  return { chart, cells: () => [{ id: 'c1', chart }], on: () => () => {} } as unknown as VelaWorkspace;
}

/** Lets the module's queued reads and writes finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('drawing tool preferences', () => {
  beforeEach(() => store.clear());

  it('reads what was saved and drops anything malformed', () => {
    expect(parseToolPrefs(null)).toEqual({ defaults: {}, templates: {} });
    expect(parseToolPrefs('not json')).toEqual({ defaults: {}, templates: {} });
    const raw = JSON.stringify({ defaults: { trendline: { color: '#f00' }, bad: 3 }, templates: { fib: [{ name: 'A' }], empty: [], nope: {} } });
    expect(parseToolPrefs(raw)).toEqual({ defaults: { trendline: { color: '#f00' } }, templates: { fib: [{ name: 'A' }] } });
  });

  it('changes one tool at a time, and forgets a reset one', () => {
    const p = { defaults: { a: { x: 1 }, b: { x: 2 } }, templates: {} };
    expect(withTool(p, 'defaults', 'a', { x: 9 }).defaults).toEqual({ a: { x: 9 }, b: { x: 2 } });
    expect(withTool(p, 'defaults', 'b', undefined).defaults).toEqual({ a: { x: 1 } });
    expect(withTool(p, 'templates', 'a', []).templates).toEqual({});
  });

  it('lays the saved settings over a layout’s own, the saved ones winning', () => {
    expect(layered({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('gives a new chart the saved settings, keeping tools only the layout styled', async () => {
    store.set(PREF_KEY, JSON.stringify({ defaults: { trendline: { color: '#saved' } }, templates: { fib: [{ name: 'Mine' }] } }));
    const chart = fakeChart({ trendline: { color: '#layout' }, ray: { color: '#layout-ray' } });
    installToolPrefs(fakeWorkspace(chart));
    await settle();
    expect(chart.drawings.setToolDefaults).toHaveBeenCalledWith({ trendline: { color: '#saved' }, ray: { color: '#layout-ray' } });
    expect(chart.drawings.setToolTemplates).toHaveBeenCalledWith({ fib: [{ name: 'Mine' }] });
  });

  it('saves the tool the user styles, and only that one', async () => {
    store.set(PREF_KEY, JSON.stringify({ defaults: { ray: { color: '#other-tab' } }, templates: {} }));
    const chart = fakeChart();
    installToolPrefs(fakeWorkspace(chart));
    await settle();
    // Another tab or window changes a different tool meanwhile; this tab's edit must not undo it.
    store.set(PREF_KEY, JSON.stringify({ defaults: { ray: { color: '#newer' } }, templates: {} }));
    chart.edit('trendline', { color: '#mine' });
    await settle();
    expect(parseToolPrefs(store.get(PREF_KEY)!).defaults).toEqual({ ray: { color: '#newer' }, trendline: { color: '#mine' } });

    chart.edit('trendline', undefined); // reset to Vela's look
    await settle();
    expect(parseToolPrefs(store.get(PREF_KEY)!).defaults).toEqual({ ray: { color: '#newer' } });
  });

  it('stops listening when the chart goes', async () => {
    const chart = fakeChart();
    const stop = installToolPrefs(fakeWorkspace(chart));
    await settle();
    stop();
    chart.edit('trendline', { color: '#late' });
    await settle();
    expect(store.has(PREF_KEY)).toBe(false);
  });
});
