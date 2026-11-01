import { describe, expect, it } from 'vitest';
import type { WatchlistItem, WatchlistSection } from './ipc';
import { tradingViewSymbol } from './tradingViewSymbols';
import { tradingViewList } from './watchlistExport';
import { parseWatchlistFile } from './watchlistImport';
import { buildRows } from './watchlistRows';

const item = (id: number, symbol: string, position: number): WatchlistItem => ({ id, symbol, name: null, position, flag: null });
const section = (id: number, name: string, position: number): WatchlistSection => ({ id, name, position, collapsed: false });

describe('tradingViewSymbol', () => {
  it('names NSE and BSE stocks as TradingView does', () => {
    expect(tradingViewSymbol('india:NSE:RELIANCE')).toBe('NSE:RELIANCE');
    expect(tradingViewSymbol('india:BSE:RELIANCE')).toBe('BSE:RELIANCE');
    // A bare broker ticker is NSE; a broker's old prefix is the Indian namespace.
    expect(tradingViewSymbol('india:HFCL')).toBe('NSE:HFCL');
    expect(tradingViewSymbol('zerodha:NSE:TCS')).toBe('NSE:TCS');
  });

  it('uses TradingView’s own spelling of an index where it differs', () => {
    expect(tradingViewSymbol('india:NSE:NIFTY_50')).toBe('NSE:NIFTY');
    expect(tradingViewSymbol('india:NSE:NIFTY_BANK')).toBe('NSE:BANKNIFTY');
    expect(tradingViewSymbol('india:NSE:NIFTY_IT')).toBe('NSE:CNXIT');
    expect(tradingViewSymbol('india:NSE:NIFTY_HEALTHCARE')).toBe('NSE:NIFTY_HEALTHCARE');
    expect(tradingViewSymbol('india:BSE:SENSEX')).toBe('BSE:SENSEX');
  });

  it('has nothing for what TradingView names differently or doesn’t have', () => {
    expect(tradingViewSymbol('csv:MYDATA')).toBeNull();
    expect(tradingViewSymbol('india:NFO:NIFTY24NOVFUT')).toBeNull();
    expect(tradingViewSymbol('binance:BTCUSDT')).toBeNull();
    expect(tradingViewSymbol('india:')).toBeNull();
  });
});

describe('tradingViewList', () => {
  it('writes the list in order on one line, sections as ### headings', () => {
    const rows = buildRows(
      [item(1, 'india:NSE:NIFTY_50', 1), item(2, 'india:NSE:RELIANCE', 3), item(3, 'india:BSE:TCS', 4), item(4, 'india:NSE:INFY', 6)],
      [section(1, 'Banks, PSU', 2), section(2, 'IT', 5)],
    );
    expect(tradingViewList(rows)).toEqual({
      text: 'NSE:NIFTY,###Banks PSU,NSE:RELIANCE,BSE:TCS,###IT,NSE:INFY',
      count: 4,
      skipped: [],
    });
  });

  it('leaves out what TradingView can’t open, and says so', () => {
    const rows = buildRows([item(1, 'csv:MYDATA', 1), item(2, 'india:NSE:SBIN', 2), item(3, 'india:NFO:NIFTY24NOVFUT', 3)], []);
    expect(tradingViewList(rows)).toEqual({ text: 'NSE:SBIN', count: 1, skipped: ['csv:MYDATA', 'india:NFO:NIFTY24NOVFUT'] });
  });

  it('writes a symbol once, however the list spells it', () => {
    const rows = buildRows([item(1, 'india:NSE:HFCL', 1), item(2, 'india:HFCL', 2)], []);
    expect(tradingViewList(rows).text).toBe('NSE:HFCL');
  });

  it('reads back in as the same symbols', () => {
    const symbols = ['india:NSE:NIFTY_50', 'india:NSE:NIFTY_IT', 'india:NSE:NIFTY_NEXT_50', 'india:NSE:RELIANCE', 'india:BSE:SENSEX'];
    const rows = buildRows(symbols.map((s, i) => item(i + 1, s, i + 2)), [section(1, 'Mine', 1)]);
    const back = parseWatchlistFile(tradingViewList(rows).text, { indian: true });
    expect(back.items.map((i) => i.symbol)).toEqual(symbols);
    expect(back.skipped).toEqual([]);
  });
});
