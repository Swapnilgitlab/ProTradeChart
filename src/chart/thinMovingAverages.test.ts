import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputValue, NativeIndicator, NativeIndicatorContext, NativeIndicatorDescriptor, NativeIndicatorOutput } from '@luxalgo/vela/plugin';

const registry = new Map<string, NativeIndicatorDescriptor>();
vi.mock('@luxalgo/vela/plugin', () => ({
  getNativeIndicator: (type: string) => registry.get(type),
  registerNativeIndicator: (descriptor: NativeIndicatorDescriptor) => registry.set(descriptor.type, descriptor),
}));

const { installThinMovingAverages, thinLines } = await import('./thinMovingAverages');

const bars = Array.from({ length: 10 }, (_, i) => ({ time: i * 1000, open: i, high: i, low: i, close: i + 1, volume: 1 }));

/** Stands in for Vela's `ClassicIndicator`: a class that keeps its context on `this` and emits a
 *  2 px line and a band fill each run. */
class FakeAverage implements NativeIndicator {
  private ctx: NativeIndicatorContext | null = null;
  private inputs: Record<string, InputValue> = {};
  start(ctx: NativeIndicatorContext, inputs: Record<string, InputValue>) {
    this.ctx = ctx;
    this.inputs = inputs;
    this.recompute();
  }
  onBars() {
    this.recompute();
  }
  onViewport() {}
  setInputs(inputs: Record<string, InputValue>) {
    this.inputs = inputs;
    this.recompute();
  }
  suspend() {}
  resume() {}
  stop() {}
  private recompute() {
    if (!this.ctx) return;
    const points = this.ctx.bars().map((b) => ({ time: b.time, value: b.close }));
    this.ctx.emit({
      series: [
        { id: 'ma', title: 'SMA', paneId: '', kind: 'line', points, style: { color: String(this.inputs.color ?? '#111111'), width: 2, lineStyle: 'solid' } },
      ],
      fills: [],
    } as NativeIndicatorOutput);
  }
}

/** Vela's originals, as `registerClassicIndicators()` puts them back on every construction. */
function velaRegisters() {
  for (const type of ['sma', 'ema', 'moving-average']) {
    registry.set(type, { type, title: type.toUpperCase(), paneHint: 'price', inputsSchema: () => [], defaultInputs: () => ({}), create: () => new FakeAverage() } as unknown as NativeIndicatorDescriptor);
  }
}

function context() {
  const emit = vi.fn();
  const ctx = { bars: () => bars, emit } as unknown as NativeIndicatorContext;
  return { ctx, emit };
}

describe('the thin moving averages', () => {
  beforeEach(() => {
    registry.clear();
    velaRegisters();
    installThinMovingAverages();
  });

  it("replaces Vela's SMA, EMA and moving average with thin ones of the same type", () => {
    expect([...registry.keys()].sort()).toEqual(['ema', 'moving-average', 'sma']);
    expect(registry.get('sma')!.title).toBe('SMA');
  });

  it('draws one-pixel lines, on the first run and every one after', () => {
    const indicator = registry.get('moving-average')!.create() as NativeIndicator;
    const { ctx, emit } = context();
    indicator.start(ctx, { color: '#ff0000' });
    indicator.setInputs({ color: '#00ff00' });
    indicator.onBars();
    expect(emit).toHaveBeenCalledTimes(3);
    for (const [out] of emit.mock.calls) {
      expect(out.series[0].style).toEqual({ color: expect.any(String), width: 1, lineStyle: 'solid' });
    }
    expect(emit.mock.calls[1][0].series[0].style.color).toBe('#00ff00');
  });

  it('accepts saved inputs before it has been started, as a restored layout supplies them', () => {
    const indicator = registry.get('sma')!.create() as NativeIndicator;
    expect(() => indicator.setInputs({ color: '#ff0000' })).not.toThrow();
    expect(() => indicator.onBars()).not.toThrow();
    const { ctx, emit } = context();
    indicator.start(ctx, { color: '#ff0000' });
    expect(emit.mock.calls[0][0].series[0].points).toHaveLength(bars.length);
  });

  it('wraps once, and again after Vela puts its own back', () => {
    const first = registry.get('sma');
    installThinMovingAverages();
    expect(registry.get('sma')).toBe(first);

    velaRegisters();
    installThinMovingAverages();
    const { ctx, emit } = context();
    (registry.get('sma')!.create() as NativeIndicator).start(ctx, {});
    expect(emit.mock.calls[0][0].series[0].style.width).toBe(1);
  });

  it('leaves everything but line widths alone', () => {
    const out = { series: [{ id: 'm', kind: 'markers', markers: [] }], fills: [{ id: 'f' }] } as unknown as NativeIndicatorOutput;
    expect(thinLines(out)).toEqual(out);
    expect(thinLines({})).toEqual({});
  });
});
