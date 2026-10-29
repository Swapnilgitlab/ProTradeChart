import { describe, expect, it } from 'vitest';
import {
  canonicalProvider,
  chartSymbol,
  DEFAULT_PROVIDER,
  displayTicker,
  INDIA,
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
    expect(splitSymbol('india:NSE:RELIANCE')).toEqual({ provider: 'india', ticker: 'NSE:RELIANCE' });
    expect(splitSymbol('csv:MY:DATA')).toEqual({ provider: 'csv', ticker: 'MY:DATA' });
  });

  it('lower-cases the provider but leaves the ticker alone', () => {
    expect(splitSymbol('INDIA:NSE:RELIANCE')).toEqual({ provider: 'india', ticker: 'NSE:RELIANCE' });
  });

  it('falls back to the default provider for a bare ticker', () => {
    expect(splitSymbol('RELIANCE')).toEqual({ provider: DEFAULT_PROVIDER, ticker: 'RELIANCE' });
    expect(splitSymbol(':RELIANCE')).toEqual({ provider: DEFAULT_PROVIDER, ticker: ':RELIANCE' });
  });
});

describe('symbol helpers', () => {
  it('normalize and display', () => {
    expect(normalizeSymbol('INDIA:NSE:RELIANCE')).toBe('india:NSE:RELIANCE');
    expect(normalizeSymbol('RELIANCE')).toBe('india:NSE:RELIANCE');
    expect(displayTicker('csv:MY_DATA')).toBe('MY_DATA');
    expect(joinSymbol('India', 'X')).toBe('india:X');
  });

  it('label known providers and pass unknown ones through', () => {
    expect(providerLabel('india')).toBe('Indian markets');
    expect(providerLabel('somenewthing')).toBe('somenewthing');
  });

  it('the default provider is the Indian namespace, naming NSE for a bare ticker', () => {
    expect(DEFAULT_PROVIDER).toBe('india');
    expect(INDIA).toBe('india');
  });
});

describe('the Indian namespace’s older spellings', () => {
  it('read a broker’s name as the Indian namespace, so symbols saved under it still load', () => {
    expect(canonicalProvider('zerodha')).toBe('india');
    expect(canonicalProvider('FYERS')).toBe('india');
    expect(canonicalProvider('csv')).toBe('csv');
    expect(splitSymbol('zerodha:NSE:RELIANCE')).toEqual({ provider: 'india', ticker: 'NSE:RELIANCE' });
    expect(splitSymbol('fyers:BSE:SBIN')).toEqual({ provider: 'india', ticker: 'BSE:SBIN' });
  });

  it('normalize to the india: form, short chart forms included', () => {
    expect(normalizeSymbol('zerodha:NSE:HFCL')).toBe('india:NSE:HFCL');
    expect(normalizeSymbol('ZERODHA:HFCL')).toBe('india:NSE:HFCL');
    expect(normalizeSymbol('fyers:BSE:SBIN')).toBe('india:BSE:SBIN');
    expect(chartSymbol('zerodha:NSE:HFCL')).toBe('india:HFCL');
    expect(displayTicker('zerodha:NSE:HFCL')).toBe('HFCL');
    expect(isSupportedSymbol('zerodha:NSE:HFCL')).toBe(true);
    expect(providerLabel('zerodha')).toBe('Indian markets');
  });

  it('are honoured when typed', () => {
    expect(resolveTypedSymbol('zerodha:hfcl', 'csv')).toBe('india:NSE:HFCL');
    expect(resolveTypedSymbol('fyers:bse:sbin', 'csv')).toBe('india:BSE:SBIN');
  });
});

describe('Indian symbols on screen', () => {
  it('hide the data source and the usual exchange', () => {
    expect(displayTicker('india:NSE:HFCL')).toBe('HFCL');
    expect(displayTicker('india:NSE:NIFTY_50')).toBe('NIFTY_50');
    expect(displayTicker('india:nse:hfcl')).toBe('hfcl');
  });

  it('keep any other exchange, because BSE:RELIANCE is not NSE:RELIANCE', () => {
    expect(displayTicker('india:BSE:RELIANCE')).toBe('BSE:RELIANCE');
    expect(displayTicker('india:NFO:RELIANCE26OCTFUT')).toBe('NFO:RELIANCE26OCTFUT');
    expect(displayTicker('india:MCX:CRUDEOIL26OCTFUT')).toBe('MCX:CRUDEOIL26OCTFUT');
  });

  it('never strip a ticker down to nothing, or touch a symbol with no exchange to hide', () => {
    expect(displayTicker('india:NSE:')).toBe('NSE:');
    expect(displayTicker('india:HFCL')).toBe('HFCL');
    expect(displayTicker('csv:MY_DATA')).toBe('MY_DATA');
    expect(displayTicker('csv:NSE:MY_DATA')).toBe('NSE:MY_DATA');
  });
});

describe('the symbol a chart is given', () => {
  it('drops the usual exchange, so the chart’s own title and status line are short', () => {
    expect(chartSymbol('india:NSE:HFCL')).toBe('india:HFCL');
    expect(chartSymbol('india:NSE:NIFTY_BANK')).toBe('india:NIFTY_BANK');
  });

  it('keeps everything a bare ticker could not stand for', () => {
    expect(chartSymbol('india:BSE:RELIANCE')).toBe('india:BSE:RELIANCE');
    expect(chartSymbol('india:MCX:GOLD26OCTFUT')).toBe('india:MCX:GOLD26OCTFUT');
    expect(chartSymbol('csv:MY_DATA')).toBe('csv:MY_DATA');
  });

  it('is undone by normalizeSymbol, so the app has one spelling of each instrument', () => {
    for (const symbol of ['india:NSE:HFCL', 'india:NSE:NIFTY_50', 'india:BSE:RELIANCE', 'india:NFO:X26OCTFUT', 'india:MCX:GOLD26OCTFUT', 'csv:MY_DATA']) {
      expect(normalizeSymbol(chartSymbol(symbol))).toBe(symbol);
    }
  });

  it('is stable: giving a chart what it already has changes nothing', () => {
    expect(chartSymbol(chartSymbol('india:NSE:HFCL'))).toBe('india:HFCL');
  });

  it('is read back as NSE by normalizeSymbol, for the Indian namespace only', () => {
    expect(normalizeSymbol('india:HFCL')).toBe('india:NSE:HFCL');
    expect(normalizeSymbol('INDIA:RELIANCE')).toBe('india:NSE:RELIANCE');
    expect(normalizeSymbol('india:BSE:RELIANCE')).toBe('india:BSE:RELIANCE');
    expect(normalizeSymbol('csv:MYDATA')).toBe('csv:MYDATA');
    expect(normalizeSymbol('india:')).toBe('india:');
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
    expect(isSupportedProvider('india')).toBe(true);
  });
});

describe('resolveTypedSymbol', () => {
  it('upper-cases a bare ticker into the default provider, naming NSE', () => {
    expect(resolveTypedSymbol(' reliance ')).toBe('india:NSE:RELIANCE');
    expect(resolveTypedSymbol('nifty_50')).toBe('india:NSE:NIFTY_50');
  });

  it('honours an explicit provider prefix', () => {
    expect(resolveTypedSymbol('india:hfcl')).toBe('india:NSE:HFCL');
    expect(resolveTypedSymbol('CSV:mydata')).toBe('csv:MYDATA');
  });

  it('returns null for empty input', () => {
    expect(resolveTypedSymbol('')).toBeNull();
    expect(resolveTypedSymbol('   ')).toBeNull();
    expect(resolveTypedSymbol('india:')).toBeNull();
  });
});

describe('resolveTypedSymbol with a default provider', () => {
  it('sends a bare ticker to the default provider, naming NSE for the Indian namespace', () => {
    expect(resolveTypedSymbol('reliance', 'india')).toBe('india:NSE:RELIANCE');
    expect(resolveTypedSymbol('mydata', 'csv')).toBe('csv:MYDATA');
  });

  it('keeps an exchange the user named, which is not a provider prefix', () => {
    expect(resolveTypedSymbol('bse:reliance', 'india')).toBe('india:BSE:RELIANCE');
    expect(resolveTypedSymbol('nfo:nifty26octfut', 'india')).toBe('india:NFO:NIFTY26OCTFUT');
  });

  it('still honours an explicit provider over the default', () => {
    expect(resolveTypedSymbol('csv:mydata', 'india')).toBe('csv:MYDATA');
    expect(resolveTypedSymbol('india:nse:infy', 'csv')).toBe('india:NSE:INFY');
    expect(resolveTypedSymbol('india:infy', 'csv')).toBe('india:NSE:INFY');
  });

  it('no longer knows the free crypto sources', () => {
    expect(providerLabel('binance')).toBe('binance');
    expect(resolveTypedSymbol('binance:btcusdt')).toBe('india:BINANCE:BTCUSDT');
  });
});

describe('Indian symbols', () => {
  it('reads a bare ticker as NSE when the Indian namespace is the default', () => {
    expect(resolveTypedSymbol('reliance', 'india')).toBe('india:NSE:RELIANCE');
    expect(resolveTypedSymbol('nifty_50', 'india')).toBe('india:NSE:NIFTY_50');
  });

  it('honours an exchange, and an explicit prefix', () => {
    expect(resolveTypedSymbol('bse:sensex', 'india')).toBe('india:BSE:SENSEX');
    expect(resolveTypedSymbol('india:infy', 'csv')).toBe('india:NSE:INFY');
    expect(resolveTypedSymbol('india:mcx:goldm26octfut', 'csv')).toBe('india:MCX:GOLDM26OCTFUT');
  });

  it('keeps the punctuation in exchange symbols', () => {
    expect(resolveTypedSymbol('m&m', 'india')).toBe('india:NSE:M&M');
    expect(resolveTypedSymbol('bajaj-auto', 'india')).toBe('india:NSE:BAJAJ-AUTO');
  });

  it('splits and labels like any other provider', () => {
    expect(providerLabel('india')).toBe('Indian markets');
    expect(splitSymbol('india:NSE:NIFTY_50')).toEqual({ provider: 'india', ticker: 'NSE:NIFTY_50' });
    expect(displayTicker('india:NSE:RELIANCE')).toBe('RELIANCE');
    expect(normalizeSymbol('INDIA:NSE:RELIANCE')).toBe('india:NSE:RELIANCE');
  });
});
