import { describe, expect, it } from 'vitest';
import { contrastOn, keepStatuslineReadable, MIN_CONTRAST, readableInk, statuslineInks } from './statuslineInk';

/** A chart's settings as Vela keeps them, with the given background and candle colours. */
function config(background: unknown, candles: Record<string, unknown> = {}) {
  return {
    layout: { background },
    candles: {
      upColor: '#089981',
      downColor: '#f23645',
      bodyVisible: true,
      borderVisible: true,
      borderUpColor: '#089981',
      borderDownColor: '#f23645',
      wickVisible: true,
      wickUpColor: '#089981',
      wickDownColor: '#f23645',
      ...candles,
    },
  };
}

describe('contrastOn', () => {
  it('is 1 for a colour on itself and 21 for black on white', () => {
    expect(contrastOn('#cccccc', '#cccccc')).toBeCloseTo(1);
    expect(contrastOn('#000000', '#ffffff')).toBeCloseTo(21);
    expect(contrastOn('#ffffff', '#000000')).toBeCloseTo(21);
  });

  it('blends a translucent ink into the background first', () => {
    expect(contrastOn('#00000000', '#ffffff')).toBeCloseTo(1);
    expect(contrastOn('transparent', '#cccccc')).toBeCloseTo(1);
    expect(contrastOn('rgba(0, 0, 0, 0)', '#cccccc')).toBeCloseTo(1);
    const half = contrastOn('#00000080', '#ffffff')!;
    expect(half).toBeGreaterThan(1);
    expect(half).toBeLessThan(21);
  });

  it('is null for a colour it can not read', () => {
    expect(contrastOn('var(--vela-up)', '#ffffff')).toBeNull();
    expect(contrastOn('#000000', undefined)).toBeNull();
  });
});

describe('readableInk', () => {
  it('takes the first colour that stands out', () => {
    expect(readableInk(['#cccccc', '#242424', '#000000'], '#cccccc')).toBe('#242424');
    expect(readableInk([undefined, '#242424'], '#cccccc')).toBe('#242424');
  });

  it('takes the theme colour as it is, since it can not be judged', () => {
    expect(readableInk([null, '#242424'], '#cccccc')).toBeNull();
  });

  it('falls back to the theme colour when none does', () => {
    expect(readableInk(['#cccccc', '#d0d0d0'], '#cccccc')).toBeNull();
    expect(readableInk([], '#cccccc')).toBeNull();
  });

  it('takes a colour it can not read as it is', () => {
    expect(readableInk(['hsl(0 0% 80%)', '#242424'], '#cccccc')).toBe('hsl(0 0% 80%)');
  });

  it('keeps the usual green and red on a mid-grey canvas', () => {
    for (const ink of ['#089981', '#f23645']) {
      expect(contrastOn(ink, '#cccccc')!).toBeGreaterThan(MIN_CONTRAST);
      expect(readableInk([ink], '#cccccc')).toBe(ink);
    }
  });

  it('turns down a colour that is nearly the canvas', () => {
    expect(contrastOn('#d9d9d9', '#ffffff')!).toBeLessThan(MIN_CONTRAST);
    expect(readableInk(['#d9d9d9'], '#ffffff')).toBeNull();
    expect(readableInk(['#cccccc'], '#e6e6e6')).toBeNull();
  });
});

describe('statuslineInks', () => {
  it('keeps the body colours when they read', () => {
    expect(statuslineInks(config('#ffffff'), 'candles', '#089981', '#f23645')).toEqual(['#089981', '#f23645']);
    expect(statuslineInks(config('#151619'), 'candles', '#089981', '#f23645')).toEqual(['#089981', '#f23645']);
  });

  it('reads hollow-looking up candles in their border colour', () => {
    // The user's own layout: up bodies the canvas colour, outlined in near-black.
    const cfg = config('#cccccc', {
      upColor: '#cccccc',
      downColor: '#2424249f',
      borderUpColor: '#242424',
      borderDownColor: '#2424247e',
      wickUpColor: '#242424fe',
      wickDownColor: '#242424b8',
    });
    expect(statuslineInks(cfg, 'candles', '#cccccc', '#2424249f')).toEqual(['#242424', '#2424249f']);
    const light = config('#e6e6e6', { upColor: '#e6e6e6de', downColor: '#000000', borderUpColor: '#000000' });
    expect(statuslineInks(light, 'candles', '#e6e6e6de', '#000000')).toEqual(['#000000', '#000000']);
  });

  it('skips a part that is not drawn', () => {
    const noBorder = config('#cccccc', { upColor: '#cccccc', borderVisible: false, borderUpColor: '#000000', wickUpColor: '#333333' });
    expect(statuslineInks(noBorder, 'candles', '#cccccc', '#f23645')[0]).toBe('#333333');
    // Bodies off: the readout follows the outline even where the body colour would read.
    const outlines = config('#ffffff', { bodyVisible: false, borderUpColor: '#000000' });
    expect(statuslineInks(outlines, 'candles', '#089981', '#f23645')[0]).toBe('#000000');
  });

  it('reads a border or wick with no colour of its own as the body colour', () => {
    const cfg = config('#cccccc', { upColor: '#cccccc', borderUpColor: null, wickUpColor: null });
    expect(statuslineInks(cfg, 'candles', '#cccccc', '#f23645')[0]).toBeNull();
  });

  it('gives the theme colour when nothing drawn reads', () => {
    const cfg = config('#cccccc', { upColor: '#cccccc', borderUpColor: '#cdcdcd', wickUpColor: '#cbcbcb' });
    expect(statuslineInks(cfg, 'candles', '#cccccc', '#f23645')).toEqual([null, '#f23645']);
  });

  it('treats Heikin Ashi and any style it does not know as candles', () => {
    const cfg = config('#cccccc', { upColor: '#cccccc', borderUpColor: '#242424' });
    expect(statuslineInks(cfg, 'heikinashi', '#cccccc', '#f23645')[0]).toBe('#242424');
    expect(statuslineInks(cfg, 'renko', '#cccccc', '#f23645')[0]).toBe('#242424');
  });

  it('keeps another style’s own colour unless it does not read', () => {
    const cfg = config('#cccccc', { borderUpColor: '#000000' });
    expect(statuslineInks(cfg, 'line', '#2962ff', '#2962ff')).toEqual(['#2962ff', '#2962ff']);
    expect(statuslineInks(cfg, 'bars', '#cccccc', '#f23645')).toEqual([null, '#f23645']);
  });

  it('leaves Vela’s pick alone on a canvas it can not read', () => {
    expect(statuslineInks(config(undefined), 'candles', '#cccccc', '#f23645')).toEqual(['#cccccc', '#f23645']);
    expect(statuslineInks(null, 'candles', '#cccccc', '#f23645')).toEqual(['#cccccc', '#f23645']);
    expect(statuslineInks(config('#cccccc'), 'candles', null, null)).toEqual([null, null]);
  });
});

describe('keepStatuslineReadable', () => {
  function fakeCell(settings: unknown, priceStyle = 'candles') {
    const calls: unknown[][] = [];
    const statusline = {
      setDirectionColors(...args: unknown[]) {
        calls.push(args);
      },
    };
    const cell = {
      statusline,
      priceStyle,
      chart: { renderer: { getConfig: () => settings } },
      syncStatuslineColors() {
        statusline.setDirectionColors('#cccccc', '#f23645', null, 'ohlc');
      },
    };
    return { cell, statusline, calls };
  }

  it('re-inks the readout at once and on every later pick, and undoes it', () => {
    const settings = config('#cccccc', { upColor: '#cccccc', borderUpColor: '#242424' });
    const { cell, statusline, calls } = fakeCell(settings);
    const original = statusline.setDirectionColors;
    const stop = keepStatuslineReadable(cell as never);
    expect(calls).toEqual([['#242424', '#f23645', null, 'ohlc']]);
    statusline.setDirectionColors('#cccccc', '#f23645', null, 'ohlc');
    expect(calls[1]).toEqual(['#242424', '#f23645', null, 'ohlc']);
    stop();
    expect(statusline.setDirectionColors).toBe(original);
  });

  it('does nothing for a cell without a status line', () => {
    expect(() => keepStatuslineReadable({ statusline: null } as never)()).not.toThrow();
  });

  it('passes Vela’s pick through when the settings can not be read', () => {
    const { cell, calls } = fakeCell(null);
    cell.chart.renderer.getConfig = () => {
      throw new Error('not built');
    };
    keepStatuslineReadable(cell as never);
    expect(calls).toEqual([['#cccccc', '#f23645', null, 'ohlc']]);
  });
});
