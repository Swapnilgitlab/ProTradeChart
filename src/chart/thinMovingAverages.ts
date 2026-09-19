import {
  registerNativeIndicator,
  type InputValue,
  type NativeIndicator,
  type NativeIndicatorContext,
  type NativeIndicatorDescriptor,
} from '@luxalgo/vela/plugin';

/** Vela's own built-in moving-average indicators ('sma', 'ema', 'moving-average')
 *  hardcode their plotted line at `width: 2` in their own source — not exposed as
 *  a configurable input, and there's no renderer-level override for a single
 *  series' width (only chart-wide chrome like gridlines/crosshair is
 *  configurable that way). Registering our own descriptors under the SAME
 *  `type` ids is the supported way to change it: `registerNativeIndicator`
 *  just overwrites the registry entry for that type (see Vela's own
 *  `REGISTRY.set(descriptor.type, descriptor)`), so `chart.addNativeIndicator`
 *  and the in-chart "Indicators" picker both pick up ours instead, under the
 *  exact same name/entry a user already sees.
 *
 *  IMPORTANT: every `new Vela()`/`new VelaWorkspace()` construction re-runs
 *  Vela's own `registerClassicIndicators()` internally, which would silently
 *  overwrite these back to width:2 — so `installThinMovingAverages()` must be
 *  called again after EVERY chart construction, not just once at module load
 *  (see ChartView.tsx, which does exactly that).
 */

const LINE_WIDTH = 1;
const DEFAULT_COLOR = '#2962ff';

function num(inputs: Record<string, InputValue>, key: string, fallback: number): number {
  const v = inputs[key];
  return typeof v === 'number' ? v : fallback;
}

function str(inputs: Record<string, InputValue>, key: string, fallback: string): string {
  const v = inputs[key];
  return typeof v === 'string' ? v : fallback;
}

function sma(values: number[], len: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

function ema(values: number[], len: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const alpha = 2 / (len + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (prev == null) {
      if (i >= len - 1) {
        prev = values.slice(i - len + 1, i + 1).reduce((a, b) => a + b, 0) / len;
        out[i] = prev;
      }
    } else {
      prev = values[i] * alpha + prev * (1 - alpha);
      out[i] = prev;
    }
  }
  return out;
}

function rma(values: number[], len: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const alpha = 1 / len;
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (prev == null) {
      if (i >= len - 1) {
        prev = values.slice(i - len + 1, i + 1).reduce((a, b) => a + b, 0) / len;
        out[i] = prev;
      }
    } else {
      prev = values[i] * alpha + prev * (1 - alpha);
      out[i] = prev;
    }
  }
  return out;
}

function wma(values: number[], len: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const denom = (len * (len + 1)) / 2;
  for (let i = len - 1; i < values.length; i++) {
    let acc = 0;
    for (let k = 0; k < len; k++) acc += values[i - k] * (len - k);
    out[i] = acc / denom;
  }
  return out;
}

function vwma(values: number[], volumes: number[], len: number): (number | null)[] {
  const pv = values.map((v, i) => v * (volumes[i] || 0));
  const pvSma = sma(pv, len);
  const volSma = sma(volumes, len);
  return pvSma.map((p, i) => {
    const v = volSma[i];
    return p != null && v ? p / v : null;
  });
}

function smoothed(kind: string, values: number[], volumes: number[], len: number): (number | null)[] {
  switch (kind) {
    case 'EMA':
      return ema(values, len);
    case 'WMA':
      return wma(values, len);
    case 'RMA':
      return rma(values, len);
    case 'VWMA':
      return vwma(values, volumes, len);
    default:
      return sma(values, len);
  }
}

class MovingAverageIndicator implements NativeIndicator {
  private ctx!: NativeIndicatorContext;
  private kind: string;
  private length = 20;
  private color = DEFAULT_COLOR;
  private readonly fixedKind?: 'SMA' | 'EMA';
  private readonly title: string;

  constructor(title: string, fixedKind?: 'SMA' | 'EMA') {
    this.title = title;
    this.fixedKind = fixedKind;
    this.kind = fixedKind ?? 'SMA';
  }

  start(ctx: NativeIndicatorContext, inputs: Record<string, InputValue>) {
    this.ctx = ctx;
    this.readInputs(inputs);
    this.recompute();
  }

  onBars() {
    this.recompute();
  }

  onViewport() {
    // Not viewport-reactive — the whole loaded history is cheap to recompute.
  }

  setInputs(inputs: Record<string, InputValue>) {
    this.readInputs(inputs);
    this.recompute();
  }

  suspend() {}
  resume() {
    this.recompute();
  }
  stop() {}

  private readInputs(inputs: Record<string, InputValue>) {
    this.length = Math.max(1, Math.trunc(num(inputs, 'length', 20)));
    this.color = str(inputs, 'color', DEFAULT_COLOR);
    if (!this.fixedKind) this.kind = str(inputs, 'maType', 'SMA');
  }

  private recompute() {
    // A restored layout applies an indicator's saved inputs before Vela has
    // started it; `start()` recomputes with those inputs once the data is there.
    if (!this.ctx) return;
    const bars = this.ctx.bars();
    const closes = bars.map((b) => b.close);
    const volumes = bars.map((b) => b.volume ?? 0);
    const values = smoothed(this.kind, closes, volumes, this.length);
    const points = bars.map((b, i) => ({ time: b.time, value: values[i] }));

    this.ctx.emit({
      series: [
        {
          id: 'ma-line',
          title: this.fixedKind ? `${this.title} ${this.length}` : `${this.kind} ${this.length}`,
          paneId: 'price',
          kind: 'line',
          points,
          style: { color: this.color, width: LINE_WIDTH, lineStyle: 'solid' },
          overlay: true,
        },
      ],
    });
  }
}

const lengthInput = { key: 'length', title: 'Length', type: 'int' as const, defval: 20, min: 1, max: 5000, step: 1 };
const colorInput = { key: 'color', title: 'Color', type: 'color' as const, defval: DEFAULT_COLOR };

const smaDescriptor: NativeIndicatorDescriptor = {
  type: 'sma',
  title: 'Simple Moving Average',
  shortTitle: 'SMA',
  paneHint: 'price',
  overlay: true,
  multiInstance: true,
  inputsSchema: () => [lengthInput, colorInput],
  defaultInputs: () => ({ length: 20, color: DEFAULT_COLOR }),
  create: () => new MovingAverageIndicator('SMA', 'SMA'),
};

const emaDescriptor: NativeIndicatorDescriptor = {
  type: 'ema',
  title: 'Exponential Moving Average',
  shortTitle: 'EMA',
  paneHint: 'price',
  overlay: true,
  multiInstance: true,
  inputsSchema: () => [lengthInput, colorInput],
  defaultInputs: () => ({ length: 20, color: DEFAULT_COLOR }),
  create: () => new MovingAverageIndicator('EMA', 'EMA'),
};

const movingAverageDescriptor: NativeIndicatorDescriptor = {
  type: 'moving-average',
  title: 'Moving Average',
  shortTitle: 'MA',
  paneHint: 'price',
  overlay: true,
  multiInstance: true,
  inputsSchema: () => [
    { key: 'maType', title: 'Type', type: 'string' as const, defval: 'SMA', options: ['SMA', 'EMA', 'WMA', 'RMA', 'VWMA'] },
    lengthInput,
    colorInput,
  ],
  defaultInputs: () => ({ maType: 'SMA', length: 20, color: DEFAULT_COLOR }),
  create: () => new MovingAverageIndicator('MA'),
};

/** Call after every chart construction (see the header comment for why). */
export function installThinMovingAverages(): void {
  registerNativeIndicator(smaDescriptor);
  registerNativeIndicator(emaDescriptor);
  registerNativeIndicator(movingAverageDescriptor);
}
