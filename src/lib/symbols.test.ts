import { describe, expect, it } from 'vitest';
import {
  chartSymbol,
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
    expect(splitSymbol('zerodha:NSE:RELIANCE')).toEqual({ provider: 'zerodha', ticker: 'NSE:RELIANCE' });
    expect(splitSymbol('csv:MY:DATA')).toEqual({ provider: 'csv', ticker: 'MY:DATA' });
  });

  it('lower-cases the provider but leaves the ticker alone', () => {
    expect(splitSymbol('ZERODHA:NSE:RELIANCE')).toEqual({ provider: 'zerodha', ticker: 'NSE:RELIANCE' });
  });

  it('falls back to the default provider for a bare ticker', () => {
    expect(splitSymbol('RELIANCE')).toEqual({ provider: DEFAULT_PROVIDER, ticker: 'RELIANCE' });
    expect(splitSymbol(':RELIANCE')).toEqual({ provider: DEFAULT_PROVIDER, ticker: ':RELIANCE' });
  });
});

describe('symbol helpers', () => {
  it('normalize and display', () => {
    expect(normalizeSymbol('ZERODHA:NSE:RELIANCE')).toBe('zerodha:NSE:RELIANCE');
    expect(normalizeSymbol('RELIANCE')).toBe('zerodha:NSE:RELIANCE');
    expect(displayTicker('csv:MY_DATA')).toBe('MY_DATA');
    expect(joinSymbol('Zerodha', 'X')).toBe('zerodha:X');
  });

  it('label known providers and pass unknown ones through', () => {
    expect(providerLabel('zerodha')).toBe('Zerodha');
    expect(providerLabel('somenewthing')).toBe('somenewthing');
  });

  it('the default provider is Zerodha, naming NSE for a bare ticker', () => {
    expect(DEFAULT_PROVIDER).toBe('zerodha');
  });
});

describe('broker symbols on screen', () => {
  it('hide the data source and the usual exchange', () => {
    expect(displayTicker('zerodha:NSE:HFCL')).toBe('HFCL');
    expect(displayTicker('zerodha:NSE:NIFTY_50')).toBe('NIFTY_50');
    expect(displayTicker('zerodha:nse:hfcl')).toBe('hfcl');
  });

  it('keep any other exchange, because BSE:RELIANCE is not NSE:RELIANCE', () => {
    expect(displayTicker('zerodha:BSE:RELIANCE')).toBe('BSE:RELIANCE');
    expect(displayTicker('zerodha:NFO:RELIANCE26OCTFUT')).toBe('NFO:RELIANCE26OCTFUT');
    expect(displayTicker('zerodha:MCX:CRUDEOIL26OCTFUT')).toBe('MCX:CRUDEOIL26OCTFUT');
  });

  it('never strip a ticker down to nothing, or touch a symbol with no exchange to hide', () => {
    expect(displayTicker('zerodha:NSE:')).toBe('NSE:');
    expect(displayTicker('zerodha:HFCL')).toBe('HFCL');
    expect(displayTicker('csv:MY_DATA')).toBe('MY_DATA');
    expect(displayTicker('csv:NSE:MY_DATA')).toBe('NSE:MY_DATA');
  });
});

describe('the symbol a chart is given', () => {
  it('drops the usual exchange, so the chart’s own title and status line are short', () => {
    expect(chartSymbol('zerodha:NSE:HFCL')).toBe('zerodha:HFCL');
    expect(chartSymbol('zerodha:NSE:NIFTY_BANK')).toBe('zerodha:NIFTY_BANK');
  });

  it('keeps everything a bare ticker could not stand for', () => {
    expect(chartSymbol('zerodha:BSE:RELIANCE')).toBe('zerodha:BSE:RELIANCE');
    expect(chartSymbol('zerodha:MCX:GOLD26OCTFUT')).toBe('zerodha:MCX:GOLD26OCTFUT');
    expect(chartSymbol('csv:MY_DATA')).toBe('csv:MY_DATA');
  });

  it('is undone by normalizeSymbol, so the app has one spelling of each instrument', () => {
    for (const symbol of ['zerodha:NSE:HFCL', 'zerodha:NSE:NIFTY_50', 'zerodha:BSE:RELIANCE', 'zerodha:NFO:X26OCTFUT', 'zerodha:MCX:GOLD26OCTFUT', 'csv:MY_DATA']) {
      expect(normalizeSymbol(chartSymbol(symbol))).toBe(symbol);
    }
  });

  it('is stable: giving a chart what it already has changes nothing', () => {
    expect(chartSymbol(chartSymbol('zerodha:NSE:HFCL'))).toBe('zerodha:HFCL');
  });

  it('is read back as NSE by normalizeSymbol, for brokers only', () => {
    expect(normalizeSymbol('zerodha:HFCL')).toBe('zerodha:NSE:HFCL');
    expect(normalizeSymbol('ZERODHA:RELIANCE')).toBe('zerodha:NSE:RELIANCE');
    expect(normalizeSymbol('zerodha:BSE:RELIANCE')).toBe('zerodha:BSE:RELIANCE');
    expect(normalizeSymbol('csv:MYDATA')).toBe('csv:MYDATA');
    expect(normalizeSymbol('zerodha:')).toBe('zerodha:');
  });
});

describe('symbols from a source the app no longer has', () => {
  it('are recognised as unsupported, so callers can say so instead of loading a blank chart', () => {
    expect(isSupportedSymbol('csv:MY_DATA')).toBe(true);
    expect(isSupportedSymbol('binance:BTCUSDT')).toBe(false);
    expect(isSupportedSymbol('coinbase:BTC-USD')).toBe(false);
    expect(isSupportedSymbol('hyperliquid:BTC')).toBe(false);
    expect(isSupportedSymbol('nonsense:X')).toBe(false);
    expect(isSupportedProvider('binance')).toBe(false);
    expect(isSupportedProvider('zerodha')).toBe(true);
  });
});

describe('resolveTypedSymbol', () => {
  it('upper-cases a bare ticker into the default provider, naming NSE', () => {
    expect(resolveTypedSymbol(' reliance ')).toBe('zerodha:NSE:RELIANCE');
    expect(resolveTypedSymbol('nifty_50')).toBe('zerodha:NSE:NIFTY_50');
  });

  it('honours an explicit provider prefix', () => {
    expect(resolveTypedSymbol('zerodha:hfcl')).toBe('zerodha:NSE:HFCL');
    expect(resolveTypedSymbol('CSV:mydata')).toBe('csv:MYDATA');
  });

  it('returns null for empty input', () => {
    expect(resolveTypedSymbol('')).toBeNull();
    expect(resolveTypedSymbol('   ')).toBeNull();
    expect(resolveTypedSymbol('zerodha:')).toBeNull();
  });
});

describe('resolveTypedSymbol with a default provider', () => {
  it('sends a bare ticker to the default provider, naming NSE for Zerodha', () => {
    expect(resolveTypedSymbol('reliance', 'zerodha')).toBe('zerodha:NSE:RELIANCE');
    expect(resolveTypedSymbol('mydata', 'csv')).toBe('csv:MYDATA');
  });

  it('keeps an exchange the user named, which is not a provider prefix', () => {
    expect(resolveTypedSymbol('bse:reliance', 'zerodha')).toBe('zerodha:BSE:RELIANCE');
    expect(resolveTypedSymbol('nfo:nifty26octfut', 'zerodha')).toBe('zerodha:NFO:NIFTY26OCTFUT');
  });

  it('still honours an explicit provider over the default', () => {
    expect(resolveTypedSymbol('csv:mydata', 'zerodha')).toBe('csv:MYDATA');
    expect(resolveTypedSymbol('zerodha:nse:infy', 'csv')).toBe('zerodha:NSE:INFY');
    expect(resolveTypedSymbol('zerodha:infy', 'csv')).toBe('zerodha:NSE:INFY');
  });

  it('no longer knows the free crypto sources', () => {
    expect(providerLabel('binance')).toBe('binance');
    expect(resolveTypedSymbol('binance:btcusdt')).toBe('zerodha:BINANCE:BTCUSDT');
  });
});

describe('Zerodha symbols', () => {
  it('reads a bare ticker as NSE when Zerodha is the default', () => {
    expect(resolveTypedSymbol('reliance', 'zerodha')).toBe('zerodha:NSE:RELIANCE');
    expect(resolveTypedSymbol('nifty_50', 'zerodha')).toBe('zerodha:NSE:NIFTY_50');
  });

  it('honours an exchange, and an explicit prefix', () => {
    expect(resolveTypedSymbol('bse:sensex', 'zerodha')).toBe('zerodha:BSE:SENSEX');
    expect(resolveTypedSymbol('zerodha:infy', 'csv')).toBe('zerodha:NSE:INFY');
    expect(resolveTypedSymbol('zerodha:mcx:goldm26octfut', 'csv')).toBe('zerodha:MCX:GOLDM26OCTFUT');
  });

  it('keeps the punctuation in Kite symbols', () => {
    expect(resolveTypedSymbol('m&m', 'zerodha')).toBe('zerodha:NSE:M&M');
    expect(resolveTypedSymbol('bajaj-auto', 'zerodha')).toBe('zerodha:NSE:BAJAJ-AUTO');
  });

  it('splits and labels like any other provider', () => {
    expect(providerLabel('zerodha')).toBe('Zerodha');
    expect(splitSymbol('zerodha:NSE:NIFTY_50')).toEqual({ provider: 'zerodha', ticker: 'NSE:NIFTY_50' });
    expect(displayTicker('zerodha:NSE:RELIANCE')).toBe('RELIANCE');
    expect(normalizeSymbol('ZERODHA:NSE:RELIANCE')).toBe('zerodha:NSE:RELIANCE');
  });
});
