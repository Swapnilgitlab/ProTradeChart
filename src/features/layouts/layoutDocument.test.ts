import { describe, expect, it } from 'vitest';
import type { WorkspaceState } from '@luxalgo/vela/workspace';
import {
  parseLayout,
  serializeLayout,
  withChartSymbols,
  withoutTheme,
  withoutUnsupportedSymbols,
  type LayoutDocument,
} from './layoutDocument';

const doc: LayoutDocument = {
  version: 1,
  tabs: [{ symbol: 'binance:ETHUSDT' }, { symbol: 'binance:BTCUSDT' }],
  activeTabIndex: 1,
};

/** A Vela state as saved under the dark theme, plus one colour the user chose themselves. */
const darkState = (): WorkspaceState =>
  ({
    version: 1,
    layout: '1',
    charts: [
      {
        id: 'c1',
        market: { symbol: 'binance:ETHUSDT', timeframe: 'D' },
        rendererConfig: {
          layout: { background: '#151619', textColor: '#b2b5be', fontSize: 12 },
          grid: { vertLines: { visible: true, color: 'rgba(32,34,44,0.2)' }, horzLines: { visible: false, color: 'rgba(32,34,44,0.2)' } },
          panes: { separatorColor: '#2a2b30', separatorWidth: 1 },
          priceScale: { borderColor: '#2a2b30', mode: 0 },
          candles: { upColor: '#ff00ff', downColor: '#f23645' },
        },
      },
    ],
  }) as unknown as WorkspaceState;

const config = (state: WorkspaceState) => (state.charts[0] as unknown as { rendererConfig: Record<string, any> }).rendererConfig;

describe('parseLayout', () => {
  it('round-trips a serialized document', () => {
    expect(parseLayout(serializeLayout(doc))).toEqual(doc);
  });

  it('keeps a per-tab Vela state untouched', () => {
    const state = { anything: { nested: true } };
    const parsed = parseLayout(JSON.stringify({ ...doc, tabs: [{ symbol: 'binance:ETHUSDT', state }] }));
    expect(parsed?.tabs[0].state).toEqual(state);
  });

  it('rejects corrupt or wrong-shaped input instead of throwing', () => {
    expect(parseLayout('not json')).toBeNull();
    expect(parseLayout('null')).toBeNull();
    expect(parseLayout('[]')).toBeNull();
    expect(parseLayout(JSON.stringify({ version: 2, tabs: [{ symbol: 'x' }] }))).toBeNull();
    expect(parseLayout(JSON.stringify({ version: 1, tabs: [] }))).toBeNull();
    expect(parseLayout(JSON.stringify({ version: 1, tabs: [{ symbol: 5 }] }))).toBeNull();
    expect(parseLayout(JSON.stringify({ version: 1, tabs: [{ symbol: '  ' }] }))).toBeNull();
  });

  it('normalises bare tickers to the default provider', () => {
    const parsed = parseLayout(JSON.stringify({ version: 1, tabs: [{ symbol: 'RELIANCE' }], activeTabIndex: 0 }));
    expect(parsed?.tabs[0].symbol).toBe('india:NSE:RELIANCE');
  });

  it('clamps an out-of-range or missing active tab index', () => {
    const at = (activeTabIndex: unknown) =>
      parseLayout(JSON.stringify({ version: 1, tabs: [{ symbol: 'a:b' }, { symbol: 'a:c' }], activeTabIndex }))?.activeTabIndex;
    expect(at(99)).toBe(1);
    expect(at(-3)).toBe(0);
    expect(at('x')).toBe(0);
    expect(at(undefined)).toBe(0);
  });

  it('ignores a theme recorded by an older version', () => {
    const parsed = parseLayout(JSON.stringify({ version: 1, tabs: [{ symbol: 'a:b' }], themeKey: 'midnight' }));
    expect(parsed && 'themeKey' in parsed).toBe(false);
  });
});

describe('a layout carries no theme', () => {
  it('is not written when saving', () => {
    const saved = serializeLayout({ ...doc, tabs: [{ symbol: 'binance:ETHUSDT', state: darkState() }], themeKey: 'midnight' } as LayoutDocument);
    expect(saved).not.toContain('themeKey');
    expect(saved).not.toContain('#151619'); // the dark background
    expect(saved).not.toContain('#b2b5be'); // the dark text colour
    expect(saved).toContain('#ff00ff'); // …but the user's own colour stays
  });

  it('is dropped from a layout saved by an older version when it is loaded', () => {
    const legacy = JSON.stringify({ version: 1, tabs: [{ symbol: 'binance:ETHUSDT', state: darkState() }], activeTabIndex: 0, themeKey: 'daylight' });
    const parsed = parseLayout(legacy)!;
    expect('themeKey' in parsed).toBe(false);
    const cfg = config(parsed.tabs[0].state!);
    expect(cfg.layout.background).toBeUndefined();
    expect(cfg.layout.textColor).toBeUndefined();
    expect(cfg.candles.upColor).toBe('#ff00ff');
  });
});

describe('withoutTheme', () => {
  it('removes exactly the settings that a theme switch changes', () => {
    const cfg = config(withoutTheme(darkState()));
    expect(cfg.layout).toEqual({ fontSize: 12 });
    expect(cfg.grid).toEqual({ vertLines: { visible: true }, horzLines: { visible: false } });
    expect(cfg.panes).toEqual({ separatorWidth: 1 });
    expect(cfg.priceScale).toEqual({ mode: 0 });
  });

  it('keeps what the user chose', () => {
    const cfg = config(withoutTheme(darkState()));
    expect(cfg.candles).toEqual({ upColor: '#ff00ff', downColor: '#f23645' });
  });

  it('does not modify the state it is given', () => {
    const original = darkState();
    withoutTheme(original);
    expect(config(original).layout.background).toBe('#151619');
  });

  it('copes with states that have no renderer config, or no charts at all', () => {
    const bare = { version: 1, layout: '1', charts: [{ id: 'c1' }, { id: 'c2', rendererConfig: 'nope' }] } as unknown as WorkspaceState;
    expect(withoutTheme(bare)).toEqual(bare);
    const empty = { version: 1, layout: '1' } as unknown as WorkspaceState;
    expect(withoutTheme(empty)).toBe(empty);
  });

  it('is idempotent', () => {
    const once = withoutTheme(darkState());
    expect(withoutTheme(once)).toEqual(once);
  });

  it('keeps a canvas background someone chose, and drops either theme’s own', () => {
    const withBackground = (background: string) => {
      const state = darkState();
      config(state).layout.background = background;
      return config(withoutTheme(state)).layout;
    };
    expect(withBackground('#0b1f3a')).toEqual({ background: '#0b1f3a', fontSize: 12 });
    expect(withBackground('rgb(253, 246, 227)')).toEqual({ background: 'rgb(253, 246, 227)', fontSize: 12 });
    // The dark and the light theme's backgrounds, however they are spelled, are the theme's.
    for (const theme of ['#151619', '#ffffff', '#FFF', 'rgb(255,255,255)']) expect(withBackground(theme)).toEqual({ fontSize: 12 });
  });
});

describe('a chosen canvas background belongs to the layout', () => {
  it('is saved and read back', () => {
    const state = darkState();
    config(state).layout.background = '#0b1f3a';
    const parsed = parseLayout(serializeLayout({ ...doc, tabs: [{ symbol: 'binance:ETHUSDT', state }] }))!;
    expect(config(parsed.tabs[0].state!).layout.background).toBe('#0b1f3a');
    // The theme's text colour still isn't: the chart picks a readable one for the background.
    expect(config(parsed.tabs[0].state!).layout.textColor).toBeUndefined();
  });
});

describe('withoutUnsupportedSymbols', () => {
  const FALLBACK = 'india:NSE:RELIANCE';
  const gridState = (...symbols: string[]) =>
    ({ version: 1, layout: '2x1', charts: symbols.map((symbol, i) => ({ id: `c${i + 1}`, symbol, provider: 'nosuch', timeframe: 'D' })) }) as unknown as WorkspaceState;
  const symbolsOf = (state: WorkspaceState) => state.charts.map((c) => c.symbol);

  it('leaves a layout of supported symbols exactly as it is', () => {
    const supported: LayoutDocument = { version: 1, tabs: [{ symbol: 'india:NSE:TCS' }, { symbol: 'csv:MY_DATA' }], activeTabIndex: 0 };
    const out = withoutUnsupportedSymbols(supported, FALLBACK);
    expect(out.replaced).toBe(0);
    expect(out.doc).toEqual(supported);
  });

  it('moves a tab whose symbol comes from a removed source, and counts it', () => {
    const out = withoutUnsupportedSymbols(
      { version: 1, tabs: [{ symbol: 'nosuch:QPOWER' }, { symbol: 'csv:MY_DATA' }, { symbol: 'nosuch:NSE:TCS' }], activeTabIndex: 0 },
      FALLBACK,
    );
    expect(out.replaced).toBe(2);
    expect(out.doc.tabs.map((t) => t.symbol)).toEqual([FALLBACK, 'csv:MY_DATA', FALLBACK]);
  });

  it('also moves the charts of a grid, one by one, and counts the tab once', () => {
    const out = withoutUnsupportedSymbols(
      { version: 1, tabs: [{ symbol: 'nosuch:AAPL', state: gridState('nosuch:AAPL', 'csv:MY_DATA', 'nosuch:MSFT') }], activeTabIndex: 0 },
      FALLBACK,
    );
    expect(out.replaced).toBe(1);
    expect(out.doc.tabs[0].symbol).toBe(FALLBACK);
    expect(symbolsOf(out.doc.tabs[0].state!)).toEqual([FALLBACK, 'csv:MY_DATA', FALLBACK]);
    // The old venue recorded beside a replaced symbol would contradict the new one; a chart left alone keeps its own.
    const [first, second, third] = out.doc.tabs[0].state!.charts;
    expect('provider' in first).toBe(false);
    expect('provider' in third).toBe(false);
    expect('provider' in second).toBe(true);
  });

  it('fixes a grid cell even when the tab label was on a supported symbol', () => {
    const out = withoutUnsupportedSymbols(
      { version: 1, tabs: [{ symbol: 'csv:MY_DATA', state: gridState('csv:MY_DATA', 'nosuch:TCS') }], activeTabIndex: 0 },
      FALLBACK,
    );
    expect(out.replaced).toBe(1);
    expect(out.doc.tabs[0].symbol).toBe('csv:MY_DATA');
    expect(symbolsOf(out.doc.tabs[0].state!)).toEqual(['csv:MY_DATA', FALLBACK]);
  });

  it('does not modify the layout it is given', () => {
    const original: LayoutDocument = { version: 1, tabs: [{ symbol: 'nosuch:AAPL', state: gridState('nosuch:AAPL') }], activeTabIndex: 0 };
    const before = JSON.stringify(original);
    withoutUnsupportedSymbols(original, FALLBACK);
    expect(JSON.stringify(original)).toBe(before);
  });
});

describe('withChartSymbols', () => {
  const state = (...symbols: string[]) =>
    ({ version: 1, charts: symbols.map((symbol, i) => ({ id: String(i), symbol, provider: symbol.split(':')[0] })) }) as unknown as WorkspaceState;
  const symbolsOf = (s: WorkspaceState) => s.charts.map((c) => c.symbol);

  it('gives each chart of a layout saved before the short form its short symbol', () => {
    const out = withChartSymbols(state('india:NSE:HFCL', 'india:BSE:RELIANCE', 'binance:BTCUSDT'));
    expect(symbolsOf(out)).toEqual(['india:HFCL', 'india:BSE:RELIANCE', 'binance:BTCUSDT']);
  });

  it('keeps everything else about a chart', () => {
    const out = withChartSymbols(state('india:NSE:INFY'));
    expect(out.charts[0]).toMatchObject({ id: '0', provider: 'india', symbol: 'india:INFY' });
  });

  it('returns the state itself when nothing needs changing, and never edits its input', () => {
    const already = state('india:HFCL', 'binance:BTCUSDT');
    expect(withChartSymbols(already)).toBe(already);
    const old = state('india:NSE:HFCL');
    withChartSymbols(old);
    expect(symbolsOf(old)).toEqual(['india:NSE:HFCL']);
  });

  it('copes with a state that has no charts', () => {
    const empty = { version: 1 } as unknown as WorkspaceState;
    expect(withChartSymbols(empty)).toBe(empty);
  });
});
