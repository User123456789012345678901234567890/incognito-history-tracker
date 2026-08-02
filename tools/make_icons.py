#!/usr/bin/env python3
"""Generates the extension's PNG icons with zero third-party dependencies.

Draws a rounded dark tile with a violet magnifier glass (search + privacy).
Rendered at 4x then box-downsampled so the edges stay smooth at 16px.

Usage:  python3 tools/make_icons.py
"""
import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
SIZES = (16, 32, 48, 128)
SS = 4  # supersampling factor

BG_TOP = (32, 21, 56)
BG_BOTTOM = (17, 12, 31)
ACCENT = (140, 116, 255)
ACCENT_SOFT = (99, 79, 214)


def rounded_rect_alpha(x, y, w, h, r):
    """Coverage (0/1) of a rounded rectangle at point (x, y)."""
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    dx, dy = x - cx, y - cy
    return 1.0 if dx * dx + dy * dy <= r * r else 0.0


def blend(dst, src, alpha):
    return tuple(round(d + (s - d) * alpha) for d, s in zip(dst, src))


def render(size):
    n = size * SS
    px = [[(0, 0, 0, 0) for _ in range(n)] for _ in range(n)]

    radius = n * 0.24
    centre = n / 2.0
    ring_r = n * 0.255          # magnifier glass radius (centre line)
    ring_w = n * 0.085          # stroke width
    glass_cx = centre - n * 0.045
    glass_cy = centre - n * 0.055
    handle_len = n * 0.20

    for j in range(n):
        for i in range(n):
            x, y = i + 0.5, j + 0.5

            tile = rounded_rect_alpha(x, y, n, n, radius)
            if tile == 0.0:
                continue

            # vertical gradient background
            t = y / n
            colour = tuple(
                round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)
            )

            # subtle top-left sheen
            sheen = max(0.0, 1.0 - math.hypot(x - n * 0.22, y - n * 0.18) / (n * 0.75))
            colour = blend(colour, (58, 44, 96), sheen * 0.55)

            # magnifier ring
            d = math.hypot(x - glass_cx, y - glass_cy)
            ring = max(0.0, 1.0 - abs(d - ring_r) / (ring_w / 2.0))
            if ring > 0:
                colour = blend(colour, ACCENT, min(1.0, ring * 2.4))

            # lens tint
            if d < ring_r - ring_w / 2.0:
                colour = blend(colour, ACCENT_SOFT, 0.20)

            # handle: thick segment heading to the bottom-right at 45 degrees
            ux, uy = math.sqrt(0.5), math.sqrt(0.5)
            sx = glass_cx + ux * (ring_r - ring_w * 0.15)
            sy = glass_cy + uy * (ring_r - ring_w * 0.15)
            proj = (x - sx) * ux + (y - sy) * uy
            proj_c = min(max(proj, 0.0), handle_len)
            hd = math.hypot(x - (sx + ux * proj_c), y - (sy + uy * proj_c))
            handle = max(0.0, 1.0 - abs(hd) / (ring_w * 0.55))
            if handle > 0:
                colour = blend(colour, ACCENT, min(1.0, handle * 2.4))

            px[j][i] = (colour[0], colour[1], colour[2], 255)

    # box downsample to the target size
    out = bytearray()
    for j in range(size):
        out.append(0)  # PNG filter byte: none
        for i in range(size):
            r = g = b = a = 0
            for dy in range(SS):
                for dx in range(SS):
                    p = px[j * SS + dy][i * SS + dx]
                    r += p[0] * p[3]
                    g += p[1] * p[3]
                    b += p[2] * p[3]
                    a += p[3]
            total = SS * SS
            if a == 0:
                out += bytes((0, 0, 0, 0))
            else:
                out += bytes((round(r / a), round(g / a), round(b / a), round(a / total)))
    return bytes(out)


def chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path, size, raw):
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, "icon%d.png" % size)
        write_png(path, size, render(size))
        print("wrote %s (%d bytes)" % (path, os.path.getsize(path)))


if __name__ == "__main__":
    main()
