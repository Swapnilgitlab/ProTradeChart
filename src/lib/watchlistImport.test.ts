import { describe, expect, it } from 'vitest';
import { mapSymbol, parseWatchlistFile } from './watchlistImport';

describe('mapSymbol', () => {
  it('cannot chart an exchange none of the app\'s data sources covers', () => {
    // The app's only live source is Zerodha (Indian markets); crypto, US and world stocks, FX and
    // their indices and futures have none.
    for (const entry of [
      'NASDAQ:AAPL', 'NYSE:BRK.B', 'LSE:VOD', 'HKEX:700', 'FX_IDC:EURUSD', 'OANDA:GBPJPY', 'SP:SPX', 'TVC:DJI',
      'BINANCE:BTCUSDT', 'COINBASE:BTCUSD', 'HYPERLIQUID:BTC',
    ]) {
      expect(mapSymbol(entry), entry).toBeNull();
    }
  });

  it('cannot chart NSE or BSE without a broker account to serve them', () => {
    expect(mapSymbol('NSE:RELIANCE')).toBeNull();
    expect(mapSymbol('BSE:TCS')).toBeNull();
  });

  it('passes through already-qualified provider symbols', () => {
    expect(mapSymbol('zerodha:NSE:INFY')).toBe('zerodha:NSE:INFY');
    expect(mapSymbol('csv:mydata')).toBe('csv:MYDATA');
  });

  it('skips a symbol from a source that no longer exists, such as an old export\'s binance: entries', () => {
    expect(mapSymbol('nosuch:NSE:INFY')).toBeNull();
    expect(mapSymbol('binance:BTCUSDT')).toBeNull();
  });

  it('sends a bare ticker to the default provider, or the one given', () => {
    expect(mapSymbol('reliance')).toBe('zerodha:NSE:RELIANCE');
    expect(mapSymbol('TCS')).toBe('zerodha:NSE:TCS');
    expect(mapSymbol('mydata', { defaultProvider: 'csv' })).toBe('csv:MYDATA');
  });

  it('rejects empty and malformed entries', () => {
    expect(mapSymbol('')).toBeNull();
    expect(mapSymbol('NSE:')).toBeNull();
    expect(mapSymbol('two words')).toBeNull();
  });
});

describe('parseWatchlistFile', () => {
  it('reads a TradingView export, ignoring section headings and duplicates', () => {
    const r = parseWatchlistFile('###MAJORS,NSE:RELIANCE,NSE:TCS,###MORE,NSE:INFY,NSE:RELIANCE', { indianProvider: 'zerodha' });
    expect(r.items.map((i) => i.symbol)).toEqual(['zerodha:NSE:RELIANCE', 'zerodha:NSE:TCS', 'zerodha:NSE:INFY']);
    expect(r.skipped).toEqual([]);
  });

  it('reads one entry per line as well', () => {
    const r = parseWatchlistFile('RELIANCE\r\nTCS\r\n');
    expect(r.items).toHaveLength(2);
  });

  it('reads a CSV with a Symbol column and an optional Name', () => {
    const r = parseWatchlistFile('Symbol,Name,Price\nRELIANCE,Reliance Industries,2900\nTCS,Tata Consultancy,4100\n');
    expect(r.items).toEqual([
      { symbol: 'zerodha:NSE:RELIANCE', name: 'Reliance Industries' },
      { symbol: 'zerodha:NSE:TCS', name: 'Tata Consultancy' },
    ]);
  });

  it('collects entries it cannot map instead of failing', () => {
    const r = parseWatchlistFile('RELIANCE,NASDAQ:AAPL,NSE:,two words');
    expect(r.items).toHaveLength(1);
    expect(r.skipped).toEqual(['NASDAQ:AAPL', 'NSE:', 'two words']);
  });

  it('reports everything as skipped when a file holds only symbols with no source', () => {
    const r = parseWatchlistFile('NASDAQ:AAPL,NYSE:KO,NSE:TCS');
    expect(r.items).toEqual([]);
    expect(r.skipped).toEqual(['NASDAQ:AAPL', 'NYSE:KO', 'NSE:TCS']);
  });

  it('returns nothing for an empty file', () => {
    expect(parseWatchlistFile('').items).toEqual([]);
    expect(parseWatchlistFile('﻿\n\n').items).toEqual([]);
  });
});

describe('importing into Zerodha', () => {
  const zerodha = { indianProvider: 'zerodha' } as const;

  it("sends NSE and BSE symbols to the user's Zerodha account", () => {
    expect(mapSymbol('NSE:RELIANCE', zerodha)).toBe('zerodha:NSE:RELIANCE');
    expect(mapSymbol('BSE:TCS', zerodha)).toBe('zerodha:BSE:TCS');
  });

  it("maps TradingView index shorthands to Zerodha's index names", () => {
    expect(mapSymbol('NSE:NIFTY', zerodha)).toBe('zerodha:NSE:NIFTY_50');
    expect(mapSymbol('NSE:NIFTY50', zerodha)).toBe('zerodha:NSE:NIFTY_50');
    expect(mapSymbol('NSE:BANKNIFTY', zerodha)).toBe('zerodha:NSE:NIFTY_BANK');
    expect(mapSymbol('BSE:SENSEX', zerodha)).toBe('zerodha:BSE:SENSEX');
  });

  it('still skips what has no source, crypto included', () => {
    expect(mapSymbol('BINANCE:BTCUSDT', zerodha)).toBeNull();
    expect(mapSymbol('NASDAQ:AAPL', zerodha)).toBeNull();
  });

  it('takes its own symbols back unchanged', () => {
    expect(mapSymbol('zerodha:NSE:INFY')).toBe('zerodha:NSE:INFY');
  });

  it('maps a whole file', () => {
    const r = parseWatchlistFile('NSE:TCS,NSE:INFY,NASDAQ:AAPL', zerodha);
    expect(r.items.map((i) => i.symbol)).toEqual(['zerodha:NSE:TCS', 'zerodha:NSE:INFY']);
    expect(r.skipped).toEqual(['NASDAQ:AAPL']);
  });
});
