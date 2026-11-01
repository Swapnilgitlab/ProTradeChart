import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { normalizeColor } from './canvasBackground';

type Cell = ReturnType<VelaWorkspace['cells']>[number];
/** A status-line ink: a CSS colour, or null for the theme's up/down colour. */
type Ink = string | null;

/** The contrast a value needs against the canvas to count as readable. Low on purpose: it is there
 *  to catch a colour that is the canvas's own or nearly, not to judge the user's palette — the
 *  usual green and red on a mid-grey canvas are only about 2.2:1, and they read. */
export const MIN_CONTRAST = 2;

/** The price styles Vela inks from colours of their own; every other style is drawn as candles. */
const OWN_COLOURS = new Set(['bars', 'line', 'area', 'baseline']);

function rgbaOf(color: unknown): [number, number, number, number] | null {
  if (typeof color === 'string' && color.trim().toLowerCase() === 'transparent') return [0, 0, 0, 0];
  const c = normalizeColor(color);
  if (!c) return null;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  return [r, g, b, c.length === 9 ? parseInt(c.slice(7, 9), 16) / 255 : 1];
}

function luminance(rgb: readonly number[]): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of `ink` drawn on `background` (1: invisible, 21: black on white), a
 *  translucent ink blended into the background first; null when either colour can't be read. */
export function contrastOn(ink: unknown, background: unknown): number | null {
  const fg = rgbaOf(ink);
  const bg = rgbaOf(background);
  if (!fg || !bg) return null;
  const seen = [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
  const [a, b] = [luminance(seen), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The first of `candidates` that reads on `background`, or null (the theme's colour) when none
 *  does; `undefined` is a part that isn't drawn, and is skipped. A colour that can't be read — the
 *  theme's (null) among them — is taken as it is: there's no telling, and it is what Vela would
 *  have used. */
export function readableInk(candidates: readonly (Ink | undefined)[], background: unknown): Ink {
  for (const ink of candidates) {
    if (ink === undefined) continue;
    if (ink === null) return null;
    const ratio = contrastOn(ink, background);
    if (ratio === null || ratio >= MIN_CONTRAST) return ink;
  }
  return null;
}

/** The up and down inks for a chart's status line, given the ones Vela picked (`up`, `down`: the
 *  price style's own colours, a candle's body). For candles, each direction takes the first part
 *  that is drawn — body, border, wick — that stands out from the canvas: up candles made to look
 *  hollow by giving them the canvas colour as body still read in their border's colour. Another
 *  style keeps its colour unless it doesn't read, and then takes the theme's. A canvas that can't
 *  be read leaves Vela's pick alone. Pure. */
export function statuslineInks(config: unknown, priceStyle: unknown, up: Ink, down: Ink): [Ink, Ink] {
  const settings = (typeof config === 'object' && config !== null ? config : {}) as {
    layout?: { background?: unknown };
    candles?: Record<string, unknown>;
  };
  const background = settings.layout?.background;
  if (!rgbaOf(background)) return [up, down];
  if (typeof priceStyle === 'string' && OWN_COLOURS.has(priceStyle)) {
    return [readableInk([up], background), readableInk([down], background)];
  }
  const candles = settings.candles ?? {};
  // A border or wick with no colour of its own is drawn in the body's.
  const part = (visible: unknown, color: unknown, body: Ink): Ink | undefined =>
    visible === false ? undefined : typeof color === 'string' ? color : body;
  const inkFor = (body: Ink, border: unknown, wick: unknown) =>
    readableInk(
      [part(candles.bodyVisible, body, body), part(candles.borderVisible, border, body), part(candles.wickVisible, wick, body)],
      background,
    );
  return [
    inkFor(up, candles.borderUpColor, candles.wickUpColor),
    inkFor(down, candles.borderDownColor, candles.wickDownColor),
  ];
}

interface StatuslineInternals {
  setDirectionColors(up: Ink, down: Ink, ...rest: unknown[]): void;
}

/** Vela inks the status line's OHLC and change values with the price style's own colours — for
 *  candles, the body's — so up candles whose body is the canvas colour (a hollow look, outlined by
 *  the border) put their values in the canvas colour too, and they vanish. Vela hands its pick to
 *  the status line's `setDirectionColors` on every settings change (a style, a colour, the
 *  background, the theme); this swaps it for `statuslineInks`'. `statusline` and
 *  `syncStatuslineColors` are private to Vela's cell: if a Vela version drops them, this does
 *  nothing and the readout keeps Vela's own inks. Returns a function that undoes it. */
export function keepStatuslineReadable(cell: Cell): () => void {
  const internals = cell as unknown as { statusline?: StatuslineInternals | null; syncStatuslineColors?: () => void };
  const statusline = internals.statusline;
  if (!statusline || typeof statusline.setDirectionColors !== 'function') return () => {};
  const original = statusline.setDirectionColors;
  const readable: StatuslineInternals['setDirectionColors'] = function (this: unknown, up, down, ...rest) {
    let inks: [Ink, Ink] = [up, down];
    try {
      inks = statuslineInks(cell.chart.renderer.getConfig(), cell.priceStyle, up, down);
    } catch {
      // A cell still being built: Vela's own inks.
    }
    original.call(this, inks[0], inks[1], ...rest);
  };
  statusline.setDirectionColors = readable;
  try {
    internals.syncStatuslineColors?.call(cell);
  } catch {
    // A cell still being built: its first settings change re-inks it.
  }
  return () => {
    if (statusline.setDirectionColors === readable) statusline.setDirectionColors = original;
  };
}
