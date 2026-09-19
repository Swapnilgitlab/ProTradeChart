import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeIndicator, NativeIndicatorContext, NativeIndicatorDescriptor } from '@luxalgo/vela/plugin';

const registered = new Map<string, NativeIndicatorDescriptor>();
vi.mock('@luxalgo/vela/plugin', () => ({
  registerNativeIndicator: (descriptor: NativeIndicatorDescriptor) => registered.set(descriptor.type, descriptor),
}));

const { installThinMovingAverages } = await import('./thinMovingAverages');

const bars = Array.from({ length: 10 }, (_, i) => ({ time: i * 1000, open: i, high: i, low: i, close: i + 1, volume: 1 }));

function context() {
  const emit = vi.fn();
  const ctx = { bars: () => bars, emit } as unknown as NativeIndicatorContext;
  return { ctx, emit };
}

describe('the thin moving averages', () => {
  beforeEach(() => {
    registered.clear();
    installThinMovingAverages();
  });

  it('registers SMA, EMA and the generic moving average', () => {
    expect([...registered.keys()].sort()).toEqual(['ema', 'moving-average', 'sma']);
  });

  it('draws a one-pixel line', () => {
    const indicator = registered.get('sma')!.create() as NativeIndicator;
    const { ctx, emit } = context();
    indicator.start(ctx, { length: 3 });
    expect(emit.mock.calls[0][0].series[0].style.width).toBe(1);
  });

  it('accepts saved inputs before it has been started, as a restored layout supplies them', () => {
    const indicator = registered.get('sma')!.create() as NativeIndicator;
    expect(() => indicator.setInputs?.({ length: 5, color: '#ff0000' })).not.toThrow();
    expect(() => indicator.onBars?.()).not.toThrow();

    // Starting it afterwards uses whichever inputs it is started with.
    const { ctx, emit } = context();
    indicator.start(ctx, { length: 5, color: '#ff0000' });
    const series = emit.mock.calls[0][0].series[0];
    expect(series.title).toBe('SMA 5');
    expect(series.style.color).toBe('#ff0000');
    expect(series.points).toHaveLength(bars.length);
  });
});
