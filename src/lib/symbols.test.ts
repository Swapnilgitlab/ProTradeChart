import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER,
  displayTicker,
  isSupportedProvider,
  isSupportedSymbol,
  joinSymbol,
  normalizeSymbol,
  providerLabel,
  resolveTypedSymbol,
  splitSymbol,
} from './symbols';

describe('splitSymbol', () => {
  it('splits provider and ticker on the first colon only', () => {
    expect(splitSymbol('binance:BTCUSDT')).toEqual({ provider: 'binance', ticker: 'BTCUSDT' });
    expect(splitSymbol('csv:MY:DATA')).toEqual({ provider: 'csv', ticker: 'MY:DATA' });
  });

  it('lower-cases the provider but leaves the ticker alone', () => {
    expect(splitSymbol('BINANCE:BTCUSDT')).toEqual({ provider: 'binance', ticker: 'BTCUSDT' });
  });

  it('falls back to the default provider for a bare ticker', () => {
    expect(splitSymbol('BTCUSDT')).toEqual({ provider: DEFAULT_PROVIDER, ticker: 'BTCUSDT' });
    expect(splitSymbol(':BTCUSDT')).toEqual({ provider: DEFAULT_PROVIDER, ticker: ':BTCUSDT' });
  });
});

describe('symbol helpers', () => {
  it('normalize and display', () => {
    expect(normalizeSymbol('BINANCE:BTCUSDT')).toBe('binance:BTCUSDT');
    expect(normalizeSymbol('BTCUSDT')).toBe('binance:BTCUSDT');
    expect(displayTicker('coinbase:BTC-USD')).toBe('BTC-USD');
    expect(joinSymbol('Binance', 'X')).toBe('binance:X');
  });

  it('label known providers and pass unknown ones through', () => {
    expect(providerLabel('binance')).toBe('Binance');
    expect(providerLabel('somenewthing')).toBe('somenewthing');
  });

  it('the default provider needs no account, so a bare ticker always has somewhere to go', () => {
    expect(DEFAULT_PROVIDER).toBe('binance');
  });
});

describe('symbols from a source the app no longer has', () => {
  it('are recognised as unsupported, so callers can say so instead of loading a blank chart', () => {
    expect(isSupportedSymbol('binance:BTCUSDT')).toBe(true);
    expect(isSupportedSymbol('dhan:NSE:RELIANCE')).toBe(true);
    expect(isSupportedSymbol('csv:MY_DATA')).toBe(true);
    expect(isSupportedSymbol('yahoo:AAPL')).toBe(false);
    expect(isSupportedSymbol('nonsense:X')).toBe(false);
    expect(isSupportedProvider('yahoo')).toBe(false);
    expect(isSupportedProvider('zerodha')).toBe(true);
  });
});

describe('resolveTypedSymbol', () => {
  it('upper-cases a bare ticker into the default provider', () => {
    expect(resolveTypedSymbol(' btcusdt ')).toBe('binance:BTCUSDT');
    expect(resolveTypedSymbol('ethusdt.p')).toBe('binance:ETHUSDT.P');
  });

  it('honours an explicit provider prefix', () => {
    expect(resolveTypedSymbol('binance:btcusdt')).toBe('binance:BTCUSDT');
    expect(resolveTypedSymbol('COINBASE:btc-usd')).toBe('coinbase:BTC-USD');
  });

  it('returns null for empty input', () => {
    expect(resolveTypedSymbol('')).toBeNull();
    expect(resolveTypedSymbol('   ')).toBeNull();
    expect(resolveTypedSymbol('binance:')).toBeNull();
  });
});

describe('resolveTypedSymbol with a default provider', () => {
  it('sends a bare ticker to the default provider, naming NSE for Dhan', () => {
    expect(resolveTypedSymbol('reliance', 'dhan')).toBe('dhan:NSE:RELIANCE');
    expect(resolveTypedSymbol('btc-usd', 'coinbase')).toBe('coinbase:BTC-USD');
    expect(resolveTypedSymbol('btcusdt', 'binance')).toBe('binance:BTCUSDT');
  });

  it('keeps an exchange the user named, which is not a provider prefix', () => {
    expect(resolveTypedSymbol('bse:reliance', 'dhan')).toBe('dhan:BSE:RELIANCE');
    expect(resolveTypedSymbol('idx:nifty', 'dhan')).toBe('dhan:IDX:NIFTY');
  });

  it('still honours an explicit provider over the default', () => {
    expect(resolveTypedSymbol('binance:btcusdt', 'dhan')).toBe('binance:BTCUSDT');
    expect(resolveTypedSymbol('dhan:nse:infy', 'binance')).toBe('dhan:NSE:INFY');
    expect(resolveTypedSymbol('dhan:infy', 'binance')).toBe('dhan:NSE:INFY');
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
    expect(resolveTypedSymbol('zerodha:infy', 'binance')).toBe('zerodha:NSE:INFY');
    expect(resolveTypedSymbol('zerodha:mcx:goldm26octfut', 'binance')).toBe('zerodha:MCX:GOLDM26OCTFUT');
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
