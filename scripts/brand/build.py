#!/usr/bin/env python3
"""Generate the ProTradeChart logo and every icon the app ships.

The mark is a single candlestick in a rounded tile ("direction 1c" from the
Claude Design exploration). The wordmark is Geist SemiBold at -0.03em tracking,
converted to outlines so the SVGs need no font.

Writes:
    assets/brand/*.svg      logo kit (lockups, wordmark, marks, icons)
    assets/app-icon.png     1024px master for `tauri icon`
    src-tauri/icons/*       via `npx tauri icon`, then the small sizes and
                            icon.ico are replaced with optically sized drawings
    public/favicon-*.png    favicon and About dialog

Usage (from the repo root):
    pip install fonttools uharfbuzz cairosvg pillow
    python3 scripts/brand/build.py [--fonts DIR]

DIR must contain Geist-SemiBold.ttf and GeistMono-Regular.ttf. If omitted, the
script runs `npm pack geist` into a temp dir and uses the fonts from there.
"""
import argparse
import glob
import io
import os
import shutil
import subprocess
import tempfile

import cairosvg
import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from PIL import Image

INK = "#0E1116"
SIGNAL = "#26D07C"
DEEP = "#0B7A55"
PAPER = "#F5F4F0"

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SVG_DIR = os.path.join(REPO, "assets", "brand")
ICONS = os.path.join(REPO, "src-tauri", "icons")
PUBLIC = os.path.join(REPO, "public")


# ---------------------------------------------------------------- the mark

# Candle geometry in the 64-unit viewBox, per size. "mark" is the lockup mark
# (tile inset to 2..62). The icon variants are full-bleed tiles whose candle
# grows as the size shrinks, so it still reads at 16px.
CANDLES = {
    "mark": dict(tile=(2, 60), wick=(10, 54, 4), body=(22, 20, 20, 22)),
    128: dict(tile=(0, 64), wick=(10, 54, 4), body=(22, 20, 20, 22)),
    64: dict(tile=(0, 64), wick=(9, 55, 5), body=(21, 19, 22, 24)),
    32: dict(tile=(0, 64), wick=(8, 56, 6), body=(20, 18, 24, 26)),
    16: dict(tile=(0, 64), wick=(8, 56, 8), body=(19, 18, 26, 28)),
}


def candle_shapes(key, candle, tx=0.0, ty=0.0, s=1.0):
    """Wick + body as SVG elements, placed at (tx, ty) with scale s."""
    g = CANDLES[key]
    y1, y2, w = g["wick"]
    bx, by, bw, bh = g["body"]
    return (
        f'<g transform="translate({fmt(tx)} {fmt(ty)}) scale({fmt(s)})">'
        f'<line x1="32" y1="{y1}" x2="32" y2="{y2}" stroke="{candle}" '
        f'stroke-width="{w}" stroke-linecap="round"/>'
        f'<rect x="{bx}" y="{by}" width="{bw}" height="{bh}" rx="3" fill="{candle}"/>'
        f"</g>"
    )


def tile_group(key, tile, candle, tx=0.0, ty=0.0, s=1.0):
    """Tile with candle. candle=None knocks the candle out (one-color use)."""
    o, size = CANDLES[key]["tile"]
    rect = (
        f'<rect x="{o}" y="{o}" width="{size}" height="{size}" rx="14"'
    )
    if candle is not None:
        return (
            f'<g transform="translate({fmt(tx)} {fmt(ty)}) scale({fmt(s)})">'
            f'{rect} fill="{tile}"/></g>'
            + candle_shapes(key, candle, tx, ty, s)
        )
    # Knockout as one even-odd path (masks are dropped by many SVG consumers).
    g = CANDLES[key]
    y1, y2, w = g["wick"]
    bx, by, bw, bh = g["body"]
    r, hw, e = 14, w / 2, o + size
    tile_d = (
        f"M{o + r} {o}H{e - r}A{r} {r} 0 0 1 {e} {o + r}V{e - r}A{r} {r} 0 0 1 {e - r} {e}"
        f"H{o + r}A{r} {r} 0 0 1 {o} {e - r}V{o + r}A{r} {r} 0 0 1 {o + r} {o}Z"
    )
    # Union of wick capsule and rounded body, traced as a single outline.
    L, R, B = 32 - hw, 32 + hw, by + bh
    candle_d = (
        f"M{fmt(L)} {by}V{y1}A{fmt(hw)} {fmt(hw)} 0 0 1 {fmt(R)} {y1}V{by}H{bx + bw - 3}"
        f"A3 3 0 0 1 {bx + bw} {by + 3}V{B - 3}A3 3 0 0 1 {bx + bw - 3} {B}H{fmt(R)}V{y2}"
        f"A{fmt(hw)} {fmt(hw)} 0 0 1 {fmt(L)} {y2}V{B}H{bx + 3}A3 3 0 0 1 {bx} {B - 3}"
        f"V{by + 3}A3 3 0 0 1 {bx + 3} {by}Z"
    )
    return (
        f'<g transform="translate({fmt(tx)} {fmt(ty)}) scale({fmt(s)})">'
        f'<path fill="{tile}" fill-rule="evenodd" d="{tile_d}{candle_d}"/></g>'
    )


# ---------------------------------------------------------------- type

class Face:
    def __init__(self, path):
        self.tt = TTFont(path)
        self.gs = self.tt.getGlyphSet()
        self.upm = self.tt["head"].unitsPerEm
        hhea = self.tt["hhea"]
        # Chromium "normal" line box: ascent - descent + lineGap, half-leading.
        self.asc = hhea.ascent
        self.line = hhea.ascent - hhea.descent + hhea.lineGap
        self.half_gap = hhea.lineGap / 2
        blob = hb.Blob.from_file_path(path)
        self.hb = hb.Font(hb.Face(blob))

    def shape(self, text, size, tracking_em):
        """Glyph runs positioned like a browser: kerning on, liga off
        (letter-spacing disables it), tracking added after every glyph."""
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(self.hb, buf, {"kern": True, "liga": False, "calt": False})
        k = size / self.upm
        order = self.tt.getGlyphOrder()
        x = 0.0
        out = []
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            out.append((order[info.codepoint], info.cluster, x + pos.x_offset * k))
            x += pos.x_advance * k + tracking_em * size
        # Advance width without the trailing tracking after the last glyph.
        return out, x - tracking_em * size

    def paths(self, glyphs, size, x0, baseline):
        """Outline path data per cluster, plus the ink bbox."""
        k = size / self.upm
        per_cluster = {}
        bounds = None
        for name, cluster, gx in glyphs:
            t = (k, 0, 0, -k, x0 + gx, baseline)
            sp = SVGPathPen(self.gs, ntos=fmt)
            self.gs[name].draw(TransformPen(sp, t))
            per_cluster.setdefault(cluster, []).append(sp.getCommands())
            bp = BoundsPen(self.gs)
            self.gs[name].draw(TransformPen(bp, t))
            if bp.bounds:
                bounds = union(bounds, bp.bounds)
        return per_cluster, bounds

    def baseline_for_center(self, size, cy):
        """Baseline y when the line box is vertically centered on cy."""
        k = size / self.upm
        return cy - self.line * k / 2 + (self.half_gap + self.asc) * k


def union(a, b):
    if a is None:
        return b
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def fmt(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


WORD = "ProTradeChart"
TRADE = range(3, 8)  # character indices of "Trade"


def wordmark(face, size, x0, baseline, base, accent):
    glyphs, width = face.shape(WORD, size, -0.03)
    per_cluster, bounds = face.paths(glyphs, size, x0, baseline)
    runs = {}
    for cluster, cmds in per_cluster.items():
        color = accent if cluster in TRADE else base
        runs.setdefault(color, []).extend(cmds)
    els = "".join(f'<path fill="{c}" d="{"".join(d)}"/>' for c, d in runs.items())
    return els, width, bounds


# ---------------------------------------------------------------- documents

def svg_doc(bounds, body, title, pad=0):
    x0, y0, x1, y1 = bounds
    x0, y0, x1, y1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
    w, h = x1 - x0, y1 - y0
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{fmt(x0)} {fmt(y0)} {fmt(w)} {fmt(h)}" '
        f'width="{fmt(w)}" height="{fmt(h)}" role="img" aria-label="{title}">'
        f"<title>{title}</title>{body}</svg>\n"
    )


def horizontal(face, mark_px, text_px, gap, tile, candle, base, accent):
    """Mark + wordmark in a row, centered on a shared axis (flex, align center)."""
    s = mark_px / 64
    cy = mark_px / 2
    mark = tile_group("mark", tile, candle, 0, 0, s)
    base_y = face.baseline_for_center(text_px, cy)
    text, _, tb = wordmark(face, text_px, mark_px + gap, base_y, base, accent)
    o, size = CANDLES["mark"]["tile"]
    tile_box = (o * s, o * s, (o + size) * s, (o + size) * s)
    b = union(tile_box, tb)
    return mark + text, b


def stacked(face, mono, mark_px, text_px, tag_px, gap, tile, candle, base, accent, tag_color):
    """Column: mark / wordmark / tagline, each centered, `gap` apart."""
    k = text_px / face.upm
    line_h = face.line * k
    tag_line = mono.line * tag_px / mono.upm
    _, word_w = face.shape(WORD, text_px, -0.03)
    tag_text = "OPEN-SOURCE CHARTING"
    tag_glyphs, tag_w = mono.shape(tag_text, tag_px, 0.12)
    cx = 0.0
    y = 0.0
    s = mark_px / 64
    mark = tile_group("mark", tile, candle, cx - mark_px / 2, y, s)
    o, size = CANDLES["mark"]["tile"]
    b = (cx - mark_px / 2 + o * s, y + o * s, cx - mark_px / 2 + (o + size) * s, y + (o + size) * s)
    y += mark_px + gap
    text, _, tb = wordmark(face, text_px, cx - word_w / 2, face.baseline_for_center(text_px, y + line_h / 2), base, accent)
    y += line_h + gap
    tag_paths, tagb = mono.paths(tag_glyphs, tag_px, cx - tag_w / 2, mono.baseline_for_center(tag_px, y + tag_line / 2))
    tag = f'<path fill="{tag_color}" d="{"".join(d for v in tag_paths.values() for d in v)}"/>'
    return mark + text + tag, union(union(b, tb), tagb)


def icon_svg(key, px):
    body = tile_group(key, SIGNAL, INK)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="{px}" height="{px}" '
        f'role="img" aria-label="ProTradeChart"><title>ProTradeChart</title>{body}</svg>\n'
    )


def icon_key_for(px):
    return 16 if px < 32 else 32 if px < 64 else 64 if px < 128 else 128


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def fetch_fonts():
    tmp = tempfile.mkdtemp()
    subprocess.run(["npm", "pack", "geist", "--silent"], cwd=tmp, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["tar", "xzf", glob.glob(os.path.join(tmp, "geist-*.tgz"))[0]], cwd=tmp, check=True)
    return os.path.join(tmp, "package", "dist", "fonts")


def find(d, name):
    hits = glob.glob(os.path.join(d, "**", name), recursive=True)
    if not hits:
        raise SystemExit(f"{name} not found under {d}")
    return hits[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fonts")
    args = ap.parse_args()
    fonts = args.fonts or fetch_fonts()
    face = Face(find(fonts, "Geist-SemiBold.ttf"))
    mono = Face(find(fonts, "GeistMono-Regular.ttf"))

    name = "ProTradeChart"

    # Marks (lockup geometry, tile only, cropped to the tile).
    marks = {
        "mark-signal": (SIGNAL, INK),
        "mark-ink": (INK, SIGNAL),
        "mark-mono-ink": (INK, None),
        "mark-mono-paper": (PAPER, None),
    }
    for fn, (tile, candle) in marks.items():
        write(os.path.join(SVG_DIR, fn + ".svg"), svg_doc((2, 2, 62, 62), tile_group("mark", tile, candle), name))

    # Horizontal lockups. 3a primary: mark 112, type 76, gap 28.
    lockups = {
        "lockup-on-dark": (112, 76, 28, SIGNAL, INK, PAPER, SIGNAL),
        "lockup-on-light": (112, 76, 28, INK, SIGNAL, INK, DEEP),
        # One-color: mark 56, type 36, gap 16; candle knocked out.
        "lockup-mono-ink": (56, 36, 16, INK, None, INK, INK),
        "lockup-mono-paper": (56, 36, 16, PAPER, None, PAPER, PAPER),
    }
    for fn, (m, t, g, tile, candle, base, accent) in lockups.items():
        body, b = horizontal(face, m, t, g, tile, candle, base, accent)
        write(os.path.join(SVG_DIR, fn + ".svg"), svg_doc(b, body, name))

    # Stacked: mark 88, type 40, tagline Geist Mono 13 / +0.12em, gaps 16.
    body, b = stacked(face, mono, 88, 40, 13, 16, INK, SIGNAL, INK, DEEP, "#5A5F66")
    write(os.path.join(SVG_DIR, "lockup-stacked-on-light.svg"), svg_doc(b, body, name))
    body, b = stacked(face, mono, 88, 40, 13, 16, SIGNAL, INK, PAPER, SIGNAL, "#8A9099")
    write(os.path.join(SVG_DIR, "lockup-stacked-on-dark.svg"), svg_doc(b, body, name))

    # Wordmark only.
    for fn, base, accent in (("wordmark-on-dark", PAPER, SIGNAL), ("wordmark-on-light", INK, DEEP)):
        text, _, tb = wordmark(face, 76, 0, 0, base, accent)
        write(os.path.join(SVG_DIR, fn + ".svg"), svg_doc(tb, text, name))

    # App icons: one SVG per optical size.
    for key in (128, 64, 32, 16):
        write(os.path.join(SVG_DIR, f"icon-{key}.svg"), icon_svg(key, key))

    def icon_png(px, pad=0):
        """The icon at px, drawn from the optical size meant for it."""
        inner = px - 2 * pad
        data = cairosvg.svg2png(bytestring=icon_svg(icon_key_for(inner), inner).encode(), output_width=inner, output_height=inner)
        im = Image.new("RGBA", (px, px))
        im.alpha_composite(Image.open(io.BytesIO(data)).convert("RGBA"), (pad, pad))
        return im

    # Master for `tauri icon`, with the same ~4% margin as the previous icon so
    # the tile sits in docks and taskbars like other apps' icons.
    master = os.path.join(REPO, "assets", "app-icon.png")
    icon_png(1024, pad=43).save(master)
    subprocess.run(["npx", "tauri", "icon", master], cwd=REPO, check=True)
    for d in ("android", "ios"):  # desktop app; tauri icon creates these anyway
        shutil.rmtree(os.path.join(ICONS, d), ignore_errors=True)

    # tauri icon only downscales the master, which blurs the candle at small
    # sizes. Replace those with the thicker small-size drawings.
    for fn, px in (("32x32.png", 32), ("Square30x30Logo.png", 30), ("Square44x44Logo.png", 44), ("64x64.png", 64)):
        icon_png(px).save(os.path.join(ICONS, fn))
    ico = {px: icon_png(px) for px in (16, 24, 32, 48, 64, 256)}
    ico[256].save(os.path.join(ICONS, "icon.ico"), sizes=[(p, p) for p in ico], append_images=list(ico.values())[:-1])

    icon_png(32).save(os.path.join(PUBLIC, "favicon-32.png"))
    icon_png(128).save(os.path.join(PUBLIC, "favicon-128.png"))

    print("wrote assets/brand, assets/app-icon.png, src-tauri/icons and public/favicon-*.png")


if __name__ == "__main__":
    main()
