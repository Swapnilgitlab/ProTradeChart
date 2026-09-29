/** A chart's canvas background belongs to its layout when one was chosen for it, and to the theme
 *  otherwise. Vela writes a background into every chart's settings — the theme's own when nobody chose
 *  one — so the two are told apart by value: Vela's default dark and light backgrounds are the
 *  theme's, anything else was picked (in Vela's chart settings) and is kept: saved with the layout,
 *  restored with it, and re-applied after a theme switch, which would otherwise re-skin it.
 *
 *  A background picked to be exactly one of the two defaults can't be told from the theme's and
 *  follows the theme. Pure. */

/** Vela's canvas backgrounds for its dark and light themes (`DARK_THEME` / `LIGHT_THEME` in its core). */
export const THEME_BACKGROUNDS = ['#151619', '#ffffff'] as const;

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const RGB = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/;

/** A colour in one spelling (`#rrggbb`, or `#rrggbbaa` when not opaque), or null when it isn't one. */
export function normalizeColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const c = value.trim().toLowerCase();
  const hex = HEX.exec(c);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    if (h.length === 8 && h.endsWith('ff')) return `#${h.slice(0, 6)}`;
    return `#${h}`;
  }
  const rgb = RGB.exec(c);
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number);
    if ([r, g, b].some((n) => n > 255)) return null;
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
    const hx = (n: number) => n.toString(16).padStart(2, '0');
    const base = `#${hx(r)}${hx(g)}${hx(b)}`;
    return alpha >= 1 ? base : `${base}${hx(Math.round(Math.max(0, alpha) * 255))}`;
  }
  return null;
}

/** Whether a background is dark, by Vela's own rule (`isDarkColor`: luminance below 128; a colour
 *  it can't read counts as dark). */
export function isDarkBackground(color: unknown): boolean {
  const c = normalizeColor(color);
  if (!c) return true;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/** The ink Vela gives its attribution mark on `background` (`applyAttributionMarkTheme`): white on
 *  dark, black on light, with a soft shadow of the opposite. */
export function attributionInk(background: unknown): { color: string; shadow: string } {
  return isDarkBackground(background) ? { color: '#ffffff', shadow: 'rgba(0,0,0,0.45)' } : { color: '#000000', shadow: 'rgba(255,255,255,0.55)' };
}

/** Whether `color` is a theme's background (or no usable colour at all). */
export function isThemeBackground(color: unknown): boolean {
  const c = normalizeColor(color);
  return c === null || (THEME_BACKGROUNDS as readonly string[]).includes(c);
}

/** The background a chart's settings (`rendererConfig`, or `renderer.getConfig()`) chose for
 *  itself, or null when it has the theme's. */
export function chosenBackground(config: unknown): string | null {
  if (typeof config !== 'object' || config === null) return null;
  const layout = (config as { layout?: unknown }).layout;
  if (typeof layout !== 'object' || layout === null) return null;
  const background = (layout as { background?: unknown }).background;
  return typeof background === 'string' && !isThemeBackground(background) ? background : null;
}
