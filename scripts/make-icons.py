"""
Render the Obelisk pin to PNG without an image library.

No rasteriser is installed on this machine (no ImageMagick, rsvg, cairo or
Pillow), so this draws the mark with plain maths and writes the PNG bytes by
hand: zlib-compressed RGBA scanlines wrapped in IHDR/IDAT/IEND.

The shape is a filled version of lucide's MapPin rather than its outline.
Outlines lose their stroke at 16px and turn into mush; a solid silhouette with
a punched-out hole stays legible at tab size, which is the whole point.

4x supersampling for the edges.
"""

import math, struct, zlib

BG = (0x09, 0x09, 0x0b)      # zinc-950, matches theme_color
FG = (0x34, 0xd3, 0x99)      # emerald-400, matches the app's mark
SS = 4                        # supersample factor


def rounded_rect(x, y, w, h, r):
    """Signed coverage test for a rounded rectangle."""
    def inside(px, py):
        cx = min(max(px, x + r), x + w - r)
        cy = min(max(py, y + r), y + h - r)
        if x + r <= px <= x + w - r or y + r <= py <= y + h - r:
            return x <= px <= x + w and y <= py <= y + h
        return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
    return inside


def pin(cx, cy, head_r, tip_y, hole_r):
    """MapPin silhouette: head circle, tapering tail to a point, hole punched."""
    def inside(px, py):
        # Head
        in_head = (px - cx) ** 2 + (py - cy) ** 2 <= head_r * head_r
        # Tail: a triangle from the circle's widest useful span down to the tip.
        # Half-width shrinks linearly from the head to the point.
        in_tail = False
        if cy <= py <= tip_y:
            t = (py - cy) / (tip_y - cy)
            half = head_r * (1.0 - t) ** 0.85
            in_tail = abs(px - cx) <= half
        if not (in_head or in_tail):
            return False
        # Hole
        if (px - cx) ** 2 + (py - cy) ** 2 <= hole_r * hole_r:
            return False
        return True
    return inside


def render(size, tile=True):
    """Return RGBA bytes for one square icon."""
    s = size
    # Geometry in 32x32 space, scaled up. Matches favicon.svg's proportions.
    k = s / 32.0
    bgtest = rounded_rect(0, 0, s, s, 7 * k)
    pintest = pin(cx=16 * k, cy=13 * k, head_r=7.2 * k, tip_y=27 * k, hole_r=2.8 * k)

    rows = []
    for py in range(s):
        row = bytearray()
        row.append(0)  # PNG filter type 0 for this scanline
        for px in range(s):
            bg_hits = fg_hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    fx = px + (sx + 0.5) / SS
                    fy = py + (sy + 0.5) / SS
                    if pintest(fx, fy):
                        fg_hits += 1
                    if bgtest(fx, fy):
                        bg_hits += 1
            total = SS * SS

            if not tile:
                # Bare mark on transparency: no tile means no tile edge, which
                # is what a browser tab wants. Colour stays constant and only
                # alpha varies, so the antialiased rim never picks up a halo of
                # whatever is behind it.
                row += bytes((FG[0], FG[1], FG[2], round(255 * fg_hits / total)))
                continue

            if bg_hits == 0:
                row += bytes((0, 0, 0, 0))
                continue
            # Composite mark over tile, then apply tile coverage as alpha.
            mark = fg_hits / bg_hits if bg_hits else 0
            r = round(BG[0] * (1 - mark) + FG[0] * mark)
            g = round(BG[1] * (1 - mark) + FG[1] * mark)
            b = round(BG[2] * (1 - mark) + FG[2] * mark)
            row += bytes((r, g, b, round(255 * bg_hits / total)))
        rows.append(bytes(row))
    return b''.join(rows)


def write_png(path, size, tile=True):
    raw = render(size, tile)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    print(f'{path}  {size}x{size}  {len(png)} bytes')


import os
BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'public', 'icons')
os.makedirs(BASE, exist_ok=True)
# Tab icon: bare mark, no tile, so nothing draws an edge around it.
write_png(f'{BASE}/favicon-32.png', 32, tile=False)
# Home-screen icons keep the tile. iOS composites a transparent PNG onto
# whatever it likes, and a bare green pin on white looks broken.
write_png(f'{BASE}/apple-touch-icon.png', 180)
write_png(f'{BASE}/icon-192.png', 192)
write_png(f'{BASE}/icon-512.png', 512)
