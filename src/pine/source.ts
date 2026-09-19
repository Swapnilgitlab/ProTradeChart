import type { PineScriptKind } from '../lib/ipc';

/** Reads the `indicator()` / `strategy()` declaration from a script's text. The saved
 *  library needs each script's kind and a default name before the engine has run it, and
 *  loading the engine on the main thread just for that would be heavy. Pine has only
 *  `//` line comments and no multi-line strings, so a line scan is enough. */

const DECLARATION = /^\s*(indicator|strategy|library)\s*\(/;

function codeLines(source: string): string[] {
  return source.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('//'));
}

/** `null` for a `library()` script (which can't be added to a chart) or no declaration. */
export function detectKind(source: string): PineScriptKind | null {
  for (const line of codeLines(source)) {
    const m = DECLARATION.exec(line);
    if (m) return m[1] === 'library' ? null : (m[1] as PineScriptKind);
  }
  return null;
}

/** The title the script declares, e.g. `My MA` for `indicator("My MA", overlay=true)`. */
export function declaredTitle(source: string): string | null {
  for (const line of codeLines(source)) {
    if (!DECLARATION.test(line)) continue;
    const m = /\(\s*(?:title\s*=\s*)?(["'])((?:\\.|(?!\1).)*)\1/.exec(line);
    return m ? m[2] : null;
  }
  return null;
}

export interface ScriptTemplate {
  id: string;
  label: string;
  kind: PineScriptKind;
  source: string;
}

/** Starting points, written for this app. Every one is compiled and run by the real
 *  engine in `source.engine.test.ts`. */
export const TEMPLATES: readonly ScriptTemplate[] = [
  {
    id: 'moving-average',
    label: 'Moving average',
    kind: 'indicator',
    source: `//@version=6
indicator("My moving average", overlay=true)

length = input.int(20, "Length", minval=1)
src = input.source(close, "Source")
lineColor = input.color(color.blue, "Colour")

basis = ta.sma(src, length)
plot(basis, "Average", color=lineColor, linewidth=2)
`,
  },
  {
    id: 'rsi',
    label: 'RSI with levels',
    kind: 'indicator',
    source: `//@version=6
indicator("My RSI", overlay=false)

length = input.int(14, "Length", minval=1)
upper = input.int(70, "Overbought")
lower = input.int(30, "Oversold")

value = ta.rsi(close, length)
plot(value, "RSI", color=color.purple)
hline(upper, "Overbought", color=color.gray, linestyle=hline.style_dashed)
hline(lower, "Oversold", color=color.gray, linestyle=hline.style_dashed)
`,
  },
  {
    id: 'sma-cross',
    label: 'Moving average cross',
    kind: 'strategy',
    source: `//@version=6
// Sized at 50% of equity: an order for 100% of equity plus commission can be
// closed by the margin check before it has a chance to trade.
strategy("My MA cross", overlay=true, initial_capital=10000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=50,
     commission_type=strategy.commission.percent, commission_value=0.05)

fastLength = input.int(10, "Fast length", minval=1)
slowLength = input.int(30, "Slow length", minval=2)

fast = ta.sma(close, fastLength)
slow = ta.sma(close, slowLength)

if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("Long")

plot(fast, "Fast", color=color.blue)
plot(slow, "Slow", color=color.orange)
`,
  },
  {
    id: 'rsi-reversion',
    label: 'RSI mean reversion',
    kind: 'strategy',
    source: `//@version=6
strategy("My RSI reversion", overlay=true, initial_capital=10000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=50,
     commission_type=strategy.commission.percent, commission_value=0.05)

length = input.int(14, "RSI length", minval=1)
oversold = input.int(30, "Buy below")
exitLevel = input.int(55, "Exit above")

value = ta.rsi(close, length)

if ta.crossunder(value, oversold)
    strategy.entry("Long", strategy.long)
if value > exitLevel
    strategy.close("Long")
`,
  },
];

export function templateById(id: string): ScriptTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
