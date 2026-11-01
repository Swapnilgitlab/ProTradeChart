import {
  getNativeIndicator,
  registerNativeIndicator,
  type NativeIndicator,
  type NativeIndicatorContext,
  type NativeIndicatorDescriptor,
  type NativeIndicatorOutput,
} from '@luxalgo/vela/plugin';

/** Vela's own moving averages ('sma', 'ema' and 'moving-average': thirteen kinds, a source, an
 *  offset, an optional second average) draw their lines 2 px wide, a width set in their source and
 *  not offered as a setting. We register Vela's own descriptors again under the SAME `type` ids,
 *  with one change: every line they emit is drawn 1 px wide. Everything else is Vela's (inputs,
 *  maths, titles), so the picker, `chart.addNativeIndicator` and saved layouts see the same
 *  indicator. `registerNativeIndicator` just overwrites the registry entry for that type (Vela's
 *  `REGISTRY.set(descriptor.type, descriptor)`).
 *
 *  IMPORTANT: every `new Vela()`/`new VelaWorkspace()` construction re-runs Vela's own
 *  `registerClassicIndicators()`, which puts the 2 px originals back, so `installThinMovingAverages()`
 *  must be called again after EVERY chart construction, not just once at module load (see
 *  ChartView.tsx and ScreenCharts.tsx, which do exactly that).
 */

const TYPES = ['sma', 'ema', 'moving-average'] as const;
const LINE_WIDTH = 1;

/** The same output with every line series drawn `LINE_WIDTH` wide. Pure. */
export function thinLines(out: NativeIndicatorOutput): NativeIndicatorOutput {
  if (!out.series) return out;
  return {
    ...out,
    series: out.series.map((s) => (s.kind === 'line' && s.style ? { ...s, style: { ...s.style, width: LINE_WIDTH } } : s)),
  };
}

/** Forwards every member to `target` (bound, so a class instance keeps its `this`), except those
 *  `overrides` names. */
function delegate<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(t, key) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key as keyof T];
      const value = Reflect.get(t, key, t);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
}

function thinIndicator(inner: NativeIndicator): NativeIndicator {
  return delegate(inner, {
    start: (ctx: NativeIndicatorContext, inputs) =>
      inner.start(delegate(ctx, { emit: (out: NativeIndicatorOutput) => ctx.emit(thinLines(out)) }), inputs),
  });
}

/** The descriptors already wrapped, so a second call before Vela re-registers its own is a no-op. */
const thinned = new WeakSet<NativeIndicatorDescriptor>();

/** Call after every chart construction (see the header comment for why). */
export function installThinMovingAverages(): void {
  for (const type of TYPES) {
    const base = getNativeIndicator(type);
    if (!base || thinned.has(base)) continue;
    const thin: NativeIndicatorDescriptor = { ...base, create: () => thinIndicator(base.create()) };
    thinned.add(thin);
    registerNativeIndicator(thin);
  }
}
