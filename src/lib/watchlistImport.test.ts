import { describe, expect, it } from 'vitest';
import { mapSymbol, parseWatchlistFile } from './watchlistImport';

describe('mapSymbol', () => {
  it('routes crypto exchanges to their own providers', () => {
    expect(mapSymbol('BINANCE:BTCUSDT')).toBe('binance:BTCUSDT');
    expect(mapSymbol('COINBASE:BTCUSD')).toBe('coinbase:BTC-USD');
    expect(mapSymbol('COINBASE:ETH-EUR')).toBe('coinbase:ETH-EUR');
    expect(mapSymbol('HYPERLIQUID:btc')).toBe('hyperliquid:BTC');
  });

  it('cannot chart an exchange none of the app\'s data sources covers', () => {
    // US and world stocks, FX, indices and futures had no source once Yahoo Finance was removed.
    for (const entry of ['NASDAQ:AAPL', 'NYSE:BRK.B', 'LSE:VOD', 'HKEX:700', 'FX_IDC:EURUSD', 'OANDA:GBPJPY', 'SP:SPX', 'TVC:DJI']) {
      expect(mapSymbol(entry), entry).toBeNull();
    }
  });

  it('cannot chart NSE or BSE without a broker account to serve them', () => {
    expect(mapSymbol('NSE:RELIANCE')).toBeNull();
    expect(mapSymbol('BSE:TCS')).toBeNull();
  });

  it('passes through already-qualified provider symbols', () => {
    expect(mapSymbol('binance:ETHUSDT')).toBe('binance:ETHUSDT');
    expect(mapSymbol('csv:mydata')).toBe('csv:MYDATA');
    expect(mapSymbol('dhan:NSE:INFY')).toBe('dhan:NSE:INFY');
  });

  it('skips a symbol from a source that no longer exists, such as an old export\'s yahoo: entries', () => {
    expect(mapSymbol('yahoo:AAPL')).toBeNull();
    expect(mapSymbol('yahoo:RELIANCE.NS')).toBeNull();
  });

  it('sends a bare ticker to the default provider, or the one given', () => {
    expect(mapSymbol('btcusdt')).toBe('binance:BTCUSDT');
    expect(mapSymbol('ETHUSDT')).toBe('binance:ETHUSDT');
    expect(mapSymbol('BTC-USD', { defaultProvider: 'coinbase' })).toBe('coinbase:BTC-USD');
    expect(mapSymbol('reliance', { defaultProvider: 'zerodha' })).toBe('zerodha:NSE:RELIANCE');
  });

  it('rejects empty and malformed entries', () => {
    expect(mapSymbol('')).toBeNull();
    expect(mapSymbol('NSE:')).toBeNull();
    expect(mapSymbol('two words')).toBeNull();
  });
});

describe('parseWatchlistFile', () => {
  it('reads a TradingView export, ignoring section headings and duplicates', () => {
    const r = parseWatchlistFile('###MAJORS,BINANCE:BTCUSDT,BINANCE:ETHUSDT,###MORE,COINBASE:BTCUSD,BINANCE:BTCUSDT');
    expect(r.items.map((i) => i.symbol)).toEqual(['binance:BTCUSDT', 'binance:ETHUSDT', 'coinbase:BTC-USD']);
    expect(r.skipped).toEqual([]);
  });

  it('reads one entry per line as well', () => {
    const r = parseWatchlistFile('BINANCE:BTCUSDT\r\nBINANCE:ETHUSDT\r\n');
    expect(r.items).toHaveLength(2);
  });

  it('reads a CSV with a Symbol column and an optional Name', () => {
    const r = parseWatchlistFile('Symbol,Name,Price\nBINANCE:BTCUSDT,Bitcoin,65000\nCOINBASE:ETHUSD,Ether,3200\n');
    expect(r.items).toEqual([
      { symbol: 'binance:BTCUSDT', name: 'Bitcoin' },
      { symbol: 'coinbase:ETH-USD', name: 'Ether' },
    ]);
  });

  it('collects entries it cannot map instead of failing', () => {
    const r = parseWatchlistFile('BINANCE:BTCUSDT,NASDAQ:AAPL,NSE:,two words');
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

describe('importing into Dhan', () => {
  const dhan = { indianProvider: 'dhan' } as const;

  it('sends NSE and BSE symbols to the Dhan provider', () => {
    expect(mapSymbol('NSE:RELIANCE', dhan)).toBe('dhan:NSE:RELIANCE');
    expect(mapSymbol('BSE:TCS', dhan)).toBe('dhan:BSE:TCS');
  });

  it('maps TradingView index shorthands onto Dhan index tickers', () => {
    expect(mapSymbol('NSE:NIFTY', dhan)).toBe('dhan:IDX:NIFTY');
    expect(mapSymbol('NSE:BANKNIFTY', dhan)).toBe('dhan:IDX:NIFTY_BANK');
    expect(mapSymbol('BSE:SENSEX', dhan)).toBe('dhan:IDX:SENSEX');
  });

  it('leaves the crypto exchanges where they were, and still skips what has no source', () => {
    expect(mapSymbol('BINANCE:BTCUSDT', dhan)).toBe('binance:BTCUSDT');
    expect(mapSymbol('NASDAQ:AAPL', dhan)).toBeNull();
  });

  it('applies to a whole file', () => {
    const r = parseWatchlistFile('NSE:TCS,NSE:INFY,NASDAQ:AAPL', dhan);
    expect(r.items.map((i) => i.symbol)).toEqual(['dhan:NSE:TCS', 'dhan:NSE:INFY']);
    expect(r.skipped).toEqual(['NASDAQ:AAPL']);
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

  it('leaves the crypto exchanges where they were, and still skips what has no source', () => {
    expect(mapSymbol('BINANCE:BTCUSDT', zerodha)).toBe('binance:BTCUSDT');
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
