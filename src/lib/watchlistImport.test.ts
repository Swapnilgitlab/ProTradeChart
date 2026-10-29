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
    expect(mapSymbol('india:NSE:INFY')).toBe('india:NSE:INFY');
    expect(mapSymbol('csv:mydata')).toBe('csv:MYDATA');
  });

  it('skips a symbol from a source that no longer exists, such as an old export\'s binance: entries', () => {
    expect(mapSymbol('nosuch:NSE:INFY')).toBeNull();
    expect(mapSymbol('binance:BTCUSDT')).toBeNull();
  });

  it('sends a bare ticker to the default provider, or the one given', () => {
    expect(mapSymbol('reliance')).toBe('india:NSE:RELIANCE');
    expect(mapSymbol('TCS')).toBe('india:NSE:TCS');
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
    const r = parseWatchlistFile('###MAJORS,NSE:RELIANCE,NSE:TCS,###MORE,NSE:INFY,NSE:RELIANCE', { indian: true });
    expect(r.items.map((i) => i.symbol)).toEqual(['india:NSE:RELIANCE', 'india:NSE:TCS', 'india:NSE:INFY']);
    expect(r.skipped).toEqual([]);
  });

  it('reads one entry per line as well', () => {
    const r = parseWatchlistFile('RELIANCE\r\nTCS\r\n');
    expect(r.items).toHaveLength(2);
  });

  it('reads a CSV with a Symbol column and an optional Name', () => {
    const r = parseWatchlistFile('Symbol,Name,Price\nRELIANCE,Reliance Industries,2900\nTCS,Tata Consultancy,4100\n');
    expect(r.items).toEqual([
      { symbol: 'india:NSE:RELIANCE', name: 'Reliance Industries' },
      { symbol: 'india:NSE:TCS', name: 'Tata Consultancy' },
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
  const indian = { indian: true } as const;

  it("sends NSE and BSE symbols to the user's Zerodha account", () => {
    expect(mapSymbol('NSE:RELIANCE', indian)).toBe('india:NSE:RELIANCE');
    expect(mapSymbol('BSE:TCS', indian)).toBe('india:BSE:TCS');
  });

  it("maps TradingView index shorthands to Zerodha's index names", () => {
    expect(mapSymbol('NSE:NIFTY', indian)).toBe('india:NSE:NIFTY_50');
    expect(mapSymbol('NSE:NIFTY50', indian)).toBe('india:NSE:NIFTY_50');
    expect(mapSymbol('NSE:BANKNIFTY', indian)).toBe('india:NSE:NIFTY_BANK');
    expect(mapSymbol('BSE:SENSEX', indian)).toBe('india:BSE:SENSEX');
  });

  it('still skips what has no source, crypto included', () => {
    expect(mapSymbol('BINANCE:BTCUSDT', indian)).toBeNull();
    expect(mapSymbol('NASDAQ:AAPL', indian)).toBeNull();
  });

  it('takes its own symbols back unchanged', () => {
    expect(mapSymbol('india:NSE:INFY')).toBe('india:NSE:INFY');
  });

  it('maps a whole file', () => {
    const r = parseWatchlistFile('NSE:TCS,NSE:INFY,NASDAQ:AAPL', indian);
    expect(r.items.map((i) => i.symbol)).toEqual(['india:NSE:TCS', 'india:NSE:INFY']);
    expect(r.skipped).toEqual(['NASDAQ:AAPL']);
  });
});
