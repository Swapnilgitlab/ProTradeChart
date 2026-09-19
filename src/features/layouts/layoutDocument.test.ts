import { describe, expect, it } from 'vitest';
import type { WorkspaceState } from '@luxalgo/vela/workspace';
import { parseLayout, serializeLayout, withoutTheme, type LayoutDocument } from './layoutDocument';

const doc: LayoutDocument = {
  version: 1,
  tabs: [{ symbol: 'yahoo:AAPL' }, { symbol: 'binance:BTCUSDT' }],
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
        market: { symbol: 'yahoo:AAPL', timeframe: 'D' },
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
    const parsed = parseLayout(JSON.stringify({ ...doc, tabs: [{ symbol: 'yahoo:AAPL', state }] }));
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
    const parsed = parseLayout(JSON.stringify({ version: 1, tabs: [{ symbol: 'AAPL' }], activeTabIndex: 0 }));
    expect(parsed?.tabs[0].symbol).toBe('yahoo:AAPL');
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
    const saved = serializeLayout({ ...doc, tabs: [{ symbol: 'yahoo:AAPL', state: darkState() }], themeKey: 'midnight' } as LayoutDocument);
    expect(saved).not.toContain('themeKey');
    expect(saved).not.toContain('#151619'); // the dark background
    expect(saved).not.toContain('#b2b5be'); // the dark text colour
    expect(saved).toContain('#ff00ff'); // …but the user's own colour stays
  });

  it('is dropped from a layout saved by an older version when it is loaded', () => {
    const legacy = JSON.stringify({ version: 1, tabs: [{ symbol: 'yahoo:AAPL', state: darkState() }], activeTabIndex: 0, themeKey: 'daylight' });
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
});
