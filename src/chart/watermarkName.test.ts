import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSymbolNames = vi.fn();
vi.mock('../lib/ipc', () => ({ getSymbolNames: (...args: unknown[]) => getSymbolNames(...args) }));

const { companyName } = await import('./watermarkName');

describe('companyName', () => {
  // Only the call history matters between tests; mockReset() would also make a
  // rejected result surface as an unhandled error (vitest 4).
  beforeEach(() => getSymbolNames.mockClear());

  it('reads the name of a broker symbol from the local database', async () => {
    getSymbolNames.mockResolvedValue({ 'dhan:NSE:INFY': 'Infosys Limited' });
    expect(await companyName('dhan:NSE:INFY')).toBe('Infosys Limited');
    expect(getSymbolNames).toHaveBeenCalledTimes(1);
    expect(getSymbolNames).toHaveBeenCalledWith(['dhan:NSE:INFY']);
  });

  it('remembers a name, so every chart on the symbol shares one answer', async () => {
    getSymbolNames.mockResolvedValue({ 'zerodha:NSE:TCS': 'Tata Consultancy Services Limited' });
    await companyName('zerodha:NSE:TCS');
    getSymbolNames.mockClear();
    expect(await companyName('zerodha:NSE:TCS')).toBe('Tata Consultancy Services Limited');
    expect(getSymbolNames).not.toHaveBeenCalled();
  });

  it('never asks about crypto or imported data, which have no names', async () => {
    expect(await companyName('binance:BTCUSDT')).toBeNull();
    expect(await companyName('csv:MY_DATA')).toBeNull();
    expect(getSymbolNames).not.toHaveBeenCalled();
  });

  it('gives null for a broker symbol the instrument list has no name for', async () => {
    getSymbolNames.mockResolvedValue({});
    expect(await companyName('dhan:NSE:NONAME')).toBeNull();
  });

  it('shrugs off a lookup that fails or comes back with nothing usable', async () => {
    getSymbolNames.mockResolvedValue(undefined);
    expect(await companyName('dhan:NSE:X1')).toBeNull();
    // Thrown rather than rejected: vitest 4 reports a rejected mock result as unhandled even when the caller catches it.
    getSymbolNames.mockImplementationOnce(() => {
      throw new Error('backend gone');
    });
    expect(await companyName('dhan:NSE:X2')).toBeNull();
  });
});
