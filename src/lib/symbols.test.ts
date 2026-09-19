import { describe, expect, it } from 'vitest';
import { displayTicker, joinSymbol, normalizeSymbol, providerLabel, resolveTypedSymbol, splitSymbol } from './symbols';

describe('splitSymbol', () => {
  it('splits provider and ticker on the first colon only', () => {
    expect(splitSymbol('yahoo:AAPL')).toEqual({ provider: 'yahoo', ticker: 'AAPL' });
    expect(splitSymbol('csv:MY:DATA')).toEqual({ provider: 'csv', ticker: 'MY:DATA' });
  });

  it('lower-cases the provider but leaves the ticker alone', () => {
    expect(splitSymbol('BINANCE:BTCUSDT')).toEqual({ provider: 'binance', ticker: 'BTCUSDT' });
  });

  it('falls back to the default provider for a bare ticker', () => {
    expect(splitSymbol('AAPL')).toEqual({ provider: 'yahoo', ticker: 'AAPL' });
    expect(splitSymbol(':AAPL')).toEqual({ provider: 'yahoo', ticker: ':AAPL' });
  });
});

describe('symbol helpers', () => {
  it('normalize and display', () => {
    expect(normalizeSymbol('BINANCE:BTCUSDT')).toBe('binance:BTCUSDT');
    expect(normalizeSymbol('AAPL')).toBe('yahoo:AAPL');
    expect(displayTicker('yahoo:^GSPC')).toBe('^GSPC');
    expect(joinSymbol('Yahoo', 'X')).toBe('yahoo:X');
  });

  it('label known providers and pass unknown ones through', () => {
    expect(providerLabel('yahoo')).toBe('Yahoo Finance');
    expect(providerLabel('somenewthing')).toBe('somenewthing');
  });
});

describe('resolveTypedSymbol', () => {
  it('upper-cases a bare ticker into the default provider', () => {
    expect(resolveTypedSymbol(' aapl ')).toBe('yahoo:AAPL');
    expect(resolveTypedSymbol('^gspc')).toBe('yahoo:^GSPC');
    expect(resolveTypedSymbol('reliance.ns')).toBe('yahoo:RELIANCE.NS');
  });

  it('honours an explicit provider prefix', () => {
    expect(resolveTypedSymbol('binance:btcusdt')).toBe('binance:BTCUSDT');
    expect(resolveTypedSymbol('COINBASE:btc-usd')).toBe('coinbase:BTC-USD');
  });

  it('returns null for empty input', () => {
    expect(resolveTypedSymbol('')).toBeNull();
    expect(resolveTypedSymbol('   ')).toBeNull();
    expect(resolveTypedSymbol('yahoo:')).toBeNull();
  });
});

describe('resolveTypedSymbol with a default provider', () => {
  it('sends a bare ticker to the default provider, naming NSE for Dhan', () => {
    expect(resolveTypedSymbol('reliance', 'dhan')).toBe('dhan:NSE:RELIANCE');
    expect(resolveTypedSymbol('aapl', 'yahoo')).toBe('yahoo:AAPL');
    expect(resolveTypedSymbol('btcusdt', 'binance')).toBe('binance:BTCUSDT');
  });

  it('keeps an exchange the user named, which is not a provider prefix', () => {
    expect(resolveTypedSymbol('bse:reliance', 'dhan')).toBe('dhan:BSE:RELIANCE');
    expect(resolveTypedSymbol('idx:nifty', 'dhan')).toBe('dhan:IDX:NIFTY');
  });

  it('still honours an explicit provider over the default', () => {
    expect(resolveTypedSymbol('yahoo:aapl', 'dhan')).toBe('yahoo:AAPL');
    expect(resolveTypedSymbol('dhan:nse:infy', 'yahoo')).toBe('dhan:NSE:INFY');
    expect(resolveTypedSymbol('dhan:infy', 'yahoo')).toBe('dhan:NSE:INFY');
  });

  it('knows Dhan as a provider', () => {
    expect(providerLabel('dhan')).toBe('Dhan');
    expect(splitSymbol('dhan:NSE:RELIANCE')).toEqual({ provider: 'dhan', ticker: 'NSE:RELIANCE' });
    expect(displayTicker('dhan:NSE:RELIANCE')).toBe('NSE:RELIANCE');
  });
});

describe('Zerodha symbols', () => {
  it('reads a bare ticker as NSE when Zerodha is the default', () => {
    expect(resolveTypedSymbol('reliance', 'zerodha')).toBe('zerodha:NSE:RELIANCE');
    expect(resolveTypedSymbol('nifty_50', 'zerodha')).toBe('zerodha:NSE:NIFTY_50');
  });

  it('honours an exchange, and an explicit prefix', () => {
    expect(resolveTypedSymbol('bse:sensex', 'zerodha')).toBe('zerodha:BSE:SENSEX');
    expect(resolveTypedSymbol('zerodha:infy', 'yahoo')).toBe('zerodha:NSE:INFY');
    expect(resolveTypedSymbol('zerodha:mcx:goldm26octfut', 'yahoo')).toBe('zerodha:MCX:GOLDM26OCTFUT');
  });

  it('keeps the punctuation in Kite symbols', () => {
    expect(resolveTypedSymbol('m&m', 'zerodha')).toBe('zerodha:NSE:M&M');
    expect(resolveTypedSymbol('bajaj-auto', 'zerodha')).toBe('zerodha:NSE:BAJAJ-AUTO');
  });

  it('splits and labels like any other provider', () => {
    expect(providerLabel('zerodha')).toBe('Zerodha');
    expect(splitSymbol('zerodha:NSE:NIFTY_50')).toEqual({ provider: 'zerodha', ticker: 'NSE:NIFTY_50' });
    expect(displayTicker('zerodha:NSE:RELIANCE')).toBe('NSE:RELIANCE');
    expect(normalizeSymbol('ZERODHA:NSE:RELIANCE')).toBe('zerodha:NSE:RELIANCE');
  });
});
