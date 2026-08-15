"""
Build every app icon from the supplied logo.

Source: brand/obelisk-logo.png — 859x859 RGBA, 75% transparent, mark
colour #07b981. The accompanying .svg is not vector; it is a 431KB wrapper
around this same raster, so there is nothing to gain by preferring it.

No image library is installed on this machine (no ImageMagick, rsvg, cairo or
Pillow), so this decodes, resamples and re-encodes PNG by hand. Box-filter
downscale in premultiplied alpha — compositing after averaging would draw a
dark halo around the mark, because a transparent pixel still carries a colour.

Every output is flattened onto the app's near-black. iOS does not honour
transparency in app artwork: it composites onto white, so a transparent icon
comes back with white corners. Full bleed and square for the same reason — the
OS applies its own rounding, and a rounded tile with transparent corners shows
those corners as white triangles.
"""

import os, struct, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ICONS = os.path.join(ROOT, 'public', 'icons')
# Kept out of public/ deliberately: it is a build input, and anything under
# public/ is copied into dist and shipped to every visitor. The logo png and its
# svg wrapper are 717KB together, for files no browser ever needs.
SOURCE = os.path.join(ROOT, 'brand', 'obelisk-logo.png')

BG = (0x09, 0x09, 0x0b)  # zinc-950, matches theme_color and the app shell


def read_png_rgba(path):
    """Decode an 8-bit RGBA PNG to (width, height, list-of-rows)."""
    data = open(path, 'rb').read()
    pos, idat = 8, bytearray()
    width = height = 0
    while pos < len(data):
        length = struct.unpack('>I', data[pos:pos + 4])[0]
        tag = data[pos + 4:pos + 8]
        if tag == b'IHDR':
            width, height, depth, colour = (*struct.unpack('>II', data[pos + 8:pos + 16]),
                                            data[pos + 16], data[pos + 17])
            if depth != 8 or colour != 6:
                raise SystemExit(f'expected 8-bit RGBA, got depth {depth} colour type {colour}')
        elif tag == b'IDAT':
            idat += data[pos + 8:pos + 8 + length]
        pos += 12 + length

    raw = zlib.decompress(bytes(idat))
    stride = width * 4
    rows, prev, i = [], bytearray(stride), 0
    for _ in range(height):
        f = raw[i]; i += 1
        line = bytearray(raw[i:i + stride]); i += stride
        if f == 1:
            for x in range(4, stride):
                line[x] = (line[x] + line[x - 4]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - 4] if x >= 4 else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - 4] if x >= 4 else 0
                b = prev[x]
                c = prev[x - 4] if x >= 4 else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        rows.append(bytes(line))
        prev = line
    return width, height, rows


def mark_bounds(width, height, rows):
    """Bounding box of the visible mark, ignoring transparent margin.

    The supplied file is not centred: the pin sits 104px from each side but 22px
    from the top and 15px from the bottom, so scaling the whole square makes the
    mark touch top and bottom while floating in horizontal margin. That reads as
    squeezed. Measuring the mark and recomposing it fixes the framing without
    touching the artwork.
    """
    minx, miny, maxx, maxy = width, height, -1, -1
    for y in range(height):
        row = rows[y]
        for x in range(width):
            if row[x * 4 + 3] > 8:
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    if maxx < 0:
        return 0, 0, width - 1, height - 1
    return minx, miny, maxx, maxy


def render_icon(width, height, rows, size, background, fill=0.72):
    """Recompose the mark, centred, at `fill` of the tile.

    0.72 is chosen, not arbitrary. The mark is measured and scaled by its LONGER
    edge, and this pin is taller than it is wide (0.79:1), so a 0.72 fill puts
    72% of the tile's height and only 57% of its width to use. Filling more made
    the icon read as crowded: the supplied pin is proportionally fatter than the
    one it replaced (0.79 against 0.68), and at 0.78 the extra width had nowhere
    to go. Scaling is uniform in both axes at every fill value — the mark is
    never distorted, only framed.

    background=None leaves the tile transparent, which is what a browser tab
    wants: the icon then sits correctly on a light or a dark toolbar. App icons
    pass a colour instead, because iOS composites transparency onto white.
    """
    minx, miny, maxx, maxy = mark_bounds(width, height, rows)
    mw, mh = maxx - minx + 1, maxy - miny + 1
    target = size * fill
    scale = min(target / mw, target / mh)
    dw, dh = max(1, round(mw * scale)), max(1, round(mh * scale))
    ox0, oy0 = (size - dw) // 2, (size - dh) // 2

    out = bytearray()
    for oy in range(size):
        out.append(0)  # PNG filter type 0
        for ox in range(size):
            if not (ox0 <= ox < ox0 + dw and oy0 <= oy < oy0 + dh):
                out += (bytes((background[0], background[1], background[2], 255))
                        if background else bytes((0, 0, 0, 0)))
                continue
            # Source window for this destination pixel, inside the mark's box.
            sx0 = minx + (ox - ox0) * mw // dw
            sx1 = max(sx0 + 1, minx + (ox - ox0 + 1) * mw // dw)
            sy0 = miny + (oy - oy0) * mh // dh
            sy1 = max(sy0 + 1, miny + (oy - oy0 + 1) * mh // dh)
            out += sample(rows, sx0, sx1, sy0, sy1, background)
    return bytes(out)


def sample(rows, x0, x1, y0, y1, background):
    """Average a source rectangle in premultiplied alpha."""
    r = g = b = a = n = 0
    for y in range(y0, y1):
        row = rows[y]
        for x in range(x0, x1):
            p = x * 4
            pa = row[p + 3]
            r += row[p] * pa
            g += row[p + 1] * pa
            b += row[p + 2] * pa
            a += pa
            n += 1
    if n == 0 or a == 0:
        return (bytes((background[0], background[1], background[2], 255))
                if background else bytes((0, 0, 0, 0)))
    mean_a = a / (n * 255)
    sr, sg, sb = r / a, g / a, b / a
    if background is None:
        # Straight alpha, colour held constant so the antialiased rim cannot
        # pick up a halo of whatever sits behind the icon.
        return bytes((round(sr), round(sg), round(sb), round(255 * mean_a)))
    return bytes((
        round(background[0] * (1 - mean_a) + sr * mean_a),
        round(background[1] * (1 - mean_a) + sg * mean_a),
        round(background[2] * (1 - mean_a) + sb * mean_a),
        255,
    ))


def write_png(path, size, raw):
    def chunk(tag, payload):
        head = struct.pack('>I', len(payload)) + tag + payload
        return head + struct.pack('>I', zlib.crc32(tag + payload) & 0xffffffff)

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    open(path, 'wb').write(png)
    print(f'{os.path.relpath(path, ROOT)}  {size}x{size}  {len(png)} bytes')
    return png


if __name__ == '__main__':
    w, h, rows = read_png_rgba(SOURCE)
    print(f'source {os.path.relpath(SOURCE, ROOT)}  {w}x{h}')

    outputs = {}

    # Tab icon: TRANSPARENT. A favicon sits on whatever the browser paints —
    # dark toolbars, light toolbars, bookmark bars — so baking a background in
    # means it looks wrong on half of them. The earlier white-border problem
    # came from a rounded tile with transparent corners, which is a different
    # thing: this has no tile at all.
    outputs['favicon-32.png'] = write_png(
        os.path.join(ICONS, 'favicon-32.png'), 32,
        render_icon(w, h, rows, 32, background=None))

    # Home-screen and store icons: OPAQUE. iOS does not honour transparency in
    # app artwork; it composites onto white, so a transparent icon returns with
    # white corners. Square and full bleed, because the OS applies its own mask.
    for name, size in (('apple-touch-icon.png', 180), ('icon-192.png', 192),
                       ('icon-512.png', 512)):
        outputs[name] = write_png(os.path.join(ICONS, name), size,
                                  render_icon(w, h, rows, size, background=BG))

    # /favicon.ico at the site root. Browsers request it by convention whatever
    # the <link> tags say, and vercel.json rewrites unmatched paths to
    # index.html — so without a real file the request is answered with HTML,
    # which browsers cache as a broken icon. Static files win over rewrites.
    #
    # ICO is a 6-byte header, one 16-byte directory entry, then the image, which
    # since Vista may be a PNG verbatim. Reuses the 32px output byte for byte.
    png32 = outputs['favicon-32.png']
    ico = (struct.pack('<HHH', 0, 1, 1)
           + struct.pack('<BBBBHHII', 32, 32, 0, 0, 1, 32, len(png32), 22)
           + png32)
    ico_path = os.path.join(ROOT, 'public', 'favicon.ico')
    open(ico_path, 'wb').write(ico)
    print(f'{os.path.relpath(ico_path, ROOT)}  32x32  {len(ico)} bytes')
