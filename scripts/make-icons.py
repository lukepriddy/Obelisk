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


def resize_onto_background(width, height, rows, size):
    """Box-filter down to size x size, flattened onto BG. Returns RGBA bytes."""
    out = bytearray()
    for oy in range(size):
        out.append(0)  # PNG filter type 0
        y0, y1 = oy * height // size, max(oy * height // size + 1, (oy + 1) * height // size)
        for ox in range(size):
            x0, x1 = ox * width // size, max(ox * width // size + 1, (ox + 1) * width // size)
            # Premultiplied accumulation: colour is only meaningful where alpha
            # is, so weight each sample by its own alpha before averaging.
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
            if n == 0:
                out += bytes((BG[0], BG[1], BG[2], 255))
                continue
            mean_a = a / (n * 255)
            if a == 0:
                out += bytes((BG[0], BG[1], BG[2], 255))
                continue
            sr, sg, sb = r / a, g / a, b / a
            out += bytes((
                round(BG[0] * (1 - mean_a) + sr * mean_a),
                round(BG[1] * (1 - mean_a) + sg * mean_a),
                round(BG[2] * (1 - mean_a) + sb * mean_a),
                255,
            ))
    return bytes(out)


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
    for name, size in (('favicon-32.png', 32), ('apple-touch-icon.png', 180),
                       ('icon-192.png', 192), ('icon-512.png', 512)):
        outputs[name] = write_png(os.path.join(ICONS, name), size,
                                  resize_onto_background(w, h, rows, size))

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
