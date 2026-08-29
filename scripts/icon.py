# -*- coding: utf-8 -*-
"""
Rasterises the app mark into a Windows .ico.

The mark itself lives in `apps/web/public/icon.svg` and is the source of truth
for the design. This redraws it rather than converting it: no SVG rasteriser is
available without pulling in a native dependency, and the mark is simple enough
— rings, a growth curve, one bright detection — that reproducing it is a few
dozen lines and stays exact.

Kept in step by hand. If the SVG changes, this changes with it; the shapes and
colours below are lifted straight from it.

    python scripts/icon.py

The result is committed to `assets/`. That is deliberate: it means building the
executable needs no Python and no Pillow, which a CI runner does not have. Run
this only when the mark itself changes.
"""
import io
import math
import os

from PIL import Image, ImageDraw

# Straight from icon.svg.
PLATE_TOP = (26, 32, 48)
PLATE_BOTTOM = (11, 13, 18)
RING = (91, 140, 255)
SWEEP = [(0.0, (91, 140, 255)), (0.55, (70, 211, 154)), (1.0, (255, 210, 61))]
DETECT = (255, 77, 94)
CONTACTS = [((74, 176), 5, (91, 140, 255), 0.55), ((104, 164), 4, (91, 140, 255), 0.40), ((139, 132), 5, (70, 211, 154), 0.65)]

# The growth curve, as the two cubic Béziers the SVG draws.
CURVE = [
    ((46, 178), (78, 176), (100, 170), (120, 152)),
    ((120, 152), (138, 136), (148, 106), (158, 74)),
    ((158, 74), (164, 56), (172, 44), (182, 36)),
]

# Drawn large and reduced, which is how the curve and rings end up smooth
# without any anti-aliasing code of our own.
SUPER = 8
SIZE = 256 * SUPER


def s(v):
    """SVG units to supersampled pixels."""
    return v * SUPER


def bezier(p0, p1, p2, p3, steps=140):
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0]
        y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
        yield x, y


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient_at(t):
    """The sweep gradient, sampled along the curve."""
    for i in range(len(SWEEP) - 1):
        t0, c0 = SWEEP[i]
        t1, c1 = SWEEP[i + 1]
        if t0 <= t <= t1:
            return mix(c0, c1, (t - t0) / (t1 - t0))
    return SWEEP[-1][1]


def draw() -> Image.Image:
    img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # The plate: a vertical gradient inside a rounded square.
    plate = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    pd = ImageDraw.Draw(plate)
    for y in range(SIZE):
        pd.line([(0, y), (SIZE, y)], fill=mix(PLATE_TOP, PLATE_BOTTOM, y / SIZE) + (255,))

    mask = Image.new('L', (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=int(s(58)), fill=255)
    img.paste(plate, (0, 0), mask)

    # Range rings and crosshairs.
    for r in (34, 62, 90):
        d.ellipse(
            [s(128 - r), s(128 - r), s(128 + r), s(128 + r)],
            outline=RING + (46,),
            width=int(s(2)),
        )
    d.line([s(38), s(128), s(218), s(128)], fill=RING + (31,), width=int(s(2)))
    d.line([s(128), s(38), s(128), s(218)], fill=RING + (31,), width=int(s(2)))

    # The growth curve. Drawn as overlapping dots so the colour can travel
    # along it — a single polyline can only take one colour.
    points = []
    for seg in CURVE:
        points.extend(bezier(*seg))
    width = s(13)
    for i, (x, y) in enumerate(points):
        colour = gradient_at(i / max(1, len(points) - 1))
        d.ellipse([s(x) - width / 2, s(y) - width / 2, s(x) + width / 2, s(y) + width / 2], fill=colour + (255,))

    # The quieter contacts.
    for (cx, cy), r, colour, alpha in CONTACTS:
        d.ellipse([s(cx - r), s(cy - r), s(cx + r), s(cy + r)], fill=colour + (round(alpha * 255),))

    # The detection: a soft flare, then the point, then a dark ring so it reads
    # against the sweep.
    flare = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    fd = ImageDraw.Draw(flare)
    for r in range(34, 0, -1):
        alpha = round(0.9 * 255 * (1 - r / 34) ** 2)
        fd.ellipse([s(196 - r), s(60 - r), s(196 + r), s(60 + r)], fill=DETECT + (alpha,))
    img.alpha_composite(flare)

    d.ellipse([s(196 - 13), s(60 - 13), s(196 + 13), s(60 + 13)], fill=DETECT + (255,))
    d.ellipse(
        [s(196 - 13), s(60 - 13), s(196 + 13), s(60 + 13)],
        outline=PLATE_BOTTOM + (255,),
        width=int(s(3.5)),
    )

    return img


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, 'assets')
    os.makedirs(out_dir, exist_ok=True)

    art = draw()

    # Every size Windows asks for, down to the 16px tray icon. Reducing from one
    # large drawing keeps the small ones legible; drawing them natively at 16px
    # would lose the curve entirely.
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [art.resize((n, n), Image.LANCZOS) for n in sizes]

    ico = os.path.join(out_dir, 'icon.ico')
    frames[-1].save(ico, format='ICO', sizes=[(n, n) for n in sizes])

    png = os.path.join(out_dir, 'icon.png')
    frames[-1].save(png, format='PNG')

    print('  assets/icon.ico  %d bytes  (%s)' % (os.path.getsize(ico), ', '.join(str(n) for n in sizes)))
    print('  assets/icon.png  %d bytes' % os.path.getsize(png))


if __name__ == '__main__':
    main()
