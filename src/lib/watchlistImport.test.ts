import { describe, expect, it } from 'vitest';
import { mapSymbol, parseWatchlistFile } from './watchlistImport';

describe('mapSymbol', () => {
  it('maps exchange-qualified equities to Yahoo tickers', () => {
    expect(mapSymbol('NSE:RELIANCE')).toBe('yahoo:RELIANCE.NS');
    expect(mapSymbol('BSE:TCS')).toBe('yahoo:TCS.BO');
    expect(mapSymbol('NASDAQ:AAPL')).toBe('yahoo:AAPL');
    expect(mapSymbol('NYSE:BRK.B')).toBe('yahoo:BRK-B');
    expect(mapSymbol('LSE:VOD')).toBe('yahoo:VOD.L');
    expect(mapSymbol('HKEX:700')).toBe('yahoo:0700.HK');
  });

  it('maps well-known indices and FX pairs', () => {
    expect(mapSymbol('NSE:NIFTY')).toBe('yahoo:^NSEI');
    expect(mapSymbol('NSE:BANKNIFTY')).toBe('yahoo:^NSEBANK');
    expect(mapSymbol('SP:SPX')).toBe('yahoo:^GSPC');
    expect(mapSymbol('TVC:DJI')).toBe('yahoo:^DJI');
    expect(mapSymbol('FX_IDC:EURUSD')).toBe('yahoo:EURUSD=X');
    expect(mapSymbol('OANDA:GBPJPY')).toBe('yahoo:GBPJPY=X');
    expect(mapSymbol('FX:NOTAPAIR')).toBeNull();
  });

  it('routes crypto exchanges to their own providers', () => {
    expect(mapSymbol('BINANCE:BTCUSDT')).toBe('binance:BTCUSDT');
    expect(mapSymbol('COINBASE:BTCUSD')).toBe('coinbase:BTC-USD');
    expect(mapSymbol('COINBASE:ETH-EUR')).toBe('coinbase:ETH-EUR');
  });

  it('passes through already-qualified provider symbols', () => {
    expect(mapSymbol('yahoo:AAPL')).toBe('yahoo:AAPL');
    expect(mapSymbol('binance:ETHUSDT')).toBe('binance:ETHUSDT');
    expect(mapSymbol('csv:mydata')).toBe('csv:MYDATA');
  });

  it('treats a bare ticker as a Yahoo symbol', () => {
    expect(mapSymbol('aapl')).toBe('yahoo:AAPL');
    expect(mapSymbol('^GSPC')).toBe('yahoo:^GSPC');
    expect(mapSymbol('BTC-USD')).toBe('yahoo:BTC-USD');
  });

  it('rejects empty and malformed entries', () => {
    expect(mapSymbol('')).toBeNull();
    expect(mapSymbol('NSE:')).toBeNull();
    expect(mapSymbol('two words')).toBeNull();
  });
});

describe('parseWatchlistFile', () => {
  it('reads a TradingView export, ignoring section headings and duplicates', () => {
    const r = parseWatchlistFile('###BANKS,NSE:HDFCBANK,NSE:ICICIBANK,###TECH,NASDAQ:AAPL,NSE:HDFCBANK');
    expect(r.items.map((i) => i.symbol)).toEqual(['yahoo:HDFCBANK.NS', 'yahoo:ICICIBANK.NS', 'yahoo:AAPL']);
    expect(r.skipped).toEqual([]);
  });

  it('reads one entry per line as well', () => {
    const r = parseWatchlistFile('NASDAQ:AAPL\r\nNASDAQ:MSFT\r\n');
    expect(r.items).toHaveLength(2);
  });

  it('reads a CSV with a Symbol column and an optional Name', () => {
    const r = parseWatchlistFile('Symbol,Name,Price\nNSE:TCS,Tata Consultancy,3500\nNASDAQ:AAPL,Apple,190\n');
    expect(r.items).toEqual([
      { symbol: 'yahoo:TCS.NS', name: 'Tata Consultancy' },
      { symbol: 'yahoo:AAPL', name: 'Apple' },
    ]);
  });

  it('collects entries it cannot map instead of failing', () => {
    const r = parseWatchlistFile('NASDAQ:AAPL,NSE:,two words');
    expect(r.items).toHaveLength(1);
    expect(r.skipped).toEqual(['NSE:', 'two words']);
  });

  it('returns nothing for an empty file', () => {
    expect(parseWatchlistFile('').items).toEqual([]);
    expect(parseWatchlistFile('\uFEFF\n\n').items).toEqual([]);
  });
});

describe('importing into Dhan', () => {
  const dhan = { indianProvider: 'dhan' } as const;

  it('sends NSE and BSE symbols to the Dhan provider when asked', () => {
    expect(mapSymbol('NSE:RELIANCE', dhan)).toBe('dhan:NSE:RELIANCE');
    expect(mapSymbol('BSE:TCS', dhan)).toBe('dhan:BSE:TCS');
  });

  it('maps TradingView index shorthands onto Dhan index tickers', () => {
    expect(mapSymbol('NSE:NIFTY', dhan)).toBe('dhan:IDX:NIFTY');
    expect(mapSymbol('NSE:BANKNIFTY', dhan)).toBe('dhan:IDX:NIFTY_BANK');
    expect(mapSymbol('BSE:SENSEX', dhan)).toBe('dhan:IDX:SENSEX');
  });

  it('leaves everything that is not Indian equity on its usual provider', () => {
    expect(mapSymbol('NASDAQ:AAPL', dhan)).toBe('yahoo:AAPL');
    expect(mapSymbol('BINANCE:BTCUSDT', dhan)).toBe('binance:BTCUSDT');
    expect(mapSymbol('NSE:RELIANCE')).toBe('yahoo:RELIANCE.NS');
  });

  it('applies to a whole file', () => {
    const r = parseWatchlistFile('NSE:TCS,NSE:INFY,NASDAQ:AAPL', dhan);
    expect(r.items.map((i) => i.symbol)).toEqual(['dhan:NSE:TCS', 'dhan:NSE:INFY', 'yahoo:AAPL']);
  });
});

describe('importing into Zerodha', () => {
  const zerodha = { indianProvider: 'zerodha' } as const;

  it('sends NSE and BSE symbols to the user\'s Zerodha account', () => {
    expect(mapSymbol('NSE:RELIANCE', zerodha)).toBe('zerodha:NSE:RELIANCE');
    expect(mapSymbol('BSE:TCS', zerodha)).toBe('zerodha:BSE:TCS');
  });

  it('maps TradingView index shorthands to Zerodha\'s index names', () => {
    expect(mapSymbol('NSE:NIFTY', zerodha)).toBe('zerodha:NSE:NIFTY_50');
    expect(mapSymbol('NSE:NIFTY50', zerodha)).toBe('zerodha:NSE:NIFTY_50');
    expect(mapSymbol('NSE:BANKNIFTY', zerodha)).toBe('zerodha:NSE:NIFTY_BANK');
    expect(mapSymbol('BSE:SENSEX', zerodha)).toBe('zerodha:BSE:SENSEX');
  });

  it('leaves everything that is not Indian where it was', () => {
    expect(mapSymbol('NASDAQ:AAPL', zerodha)).toBe('yahoo:AAPL');
    expect(mapSymbol('BINANCE:BTCUSDT', zerodha)).toBe('binance:BTCUSDT');
  });

  it('takes its own symbols back unchanged', () => {
    expect(mapSymbol('zerodha:NSE:INFY')).toBe('zerodha:NSE:INFY');
  });

  it('maps a whole file', () => {
    const r = parseWatchlistFile('NSE:TCS,NSE:INFY,NASDAQ:AAPL', zerodha);
    expect(r.items.map((i) => i.symbol)).toEqual(['zerodha:NSE:TCS', 'zerodha:NSE:INFY', 'yahoo:AAPL']);
  });
});
