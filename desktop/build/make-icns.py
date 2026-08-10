#!/usr/bin/env python3
"""
Build desktop/build/icon.icns by stacking our own per-tier PNG renders,
instead of letting a tool downscale a single plated master (which would
smear the plate border into the 32/16px tiers -- see the tier rule in
desktop/build/icon-sources/ and the icon-packaging Kleos decision).

Why hand-rolled: ImageMagick 7.1.2-Q16-HDRI on this Windows box CAN write
an .icns file (exit 0, no error) but silently keeps only the first input
image -- measured via `magick identify -format "%n frames"` returning 1
regardless of how many PNGs are passed on the command line, unlike its
.ico writer which correctly embeds all frames. So this script builds the
Apple Icon Image (icns) TOC directly: it is a simple, stable, documented
container (magic "icns" + total size, then repeated
[4-byte OSType][4-byte big-endian length incl. header][raw PNG bytes]
entries) -- the same approach used by cross-platform tools like
png2icns/icnsutil that don't require macOS either.

Verifiable on this box: file structure only (magic, TOC types/sizes/PNG
signatures) -- NOT actual rendering in Finder/Dock, which needs real macOS.
"""
import struct
import sys
from pathlib import Path

SRC = Path(__file__).parent / "icon-sources"

# OSType -> (source PNG, expected pixel size) using our own tier renders.
# 16/32 are the bare (plate-less) geometry; 64/128/256/512 keep the plate.
ENTRIES = [
    ("icp4", "kory-16.png", 16),    # 1x 16pt
    ("icp5", "kory-32.png", 32),    # 1x 32pt
    ("ic11", "kory-32.png", 32),    # 2x 16pt (reuses the 32px bare render)
    ("ic12", "kory-64.png", 64),    # 2x 32pt
    ("ic07", "kory-128.png", 128),  # 1x 128pt
    ("ic08", "kory-256.png", 256),  # 1x 256pt
    ("ic13", "kory-256.png", 256),  # 2x 128pt (reuses the 256px render)
    ("ic09", "kory-512.png", 512),  # 1x 512pt
    ("ic14", "kory-512.png", 512),  # 2x 256pt (reuses the 512px render)
    ("ic10", "kory-1024.png", 1024),  # 2x 512pt -- macOS Retina dock size,
    # rendered separately from kory-plate.svg (plate treatment, since 1024 > 64)
    # via `magick -background none -density 384 kory-plate.svg -resize 1024x1024`.
]

PNG_SIG = b"\x89PNG\r\n\x1a\n"


def read_png_size(data: bytes) -> tuple[int, int]:
    if data[:8] != PNG_SIG:
        raise ValueError("not a PNG (bad signature)")
    w, h = struct.unpack(">II", data[16:24])
    return w, h


def main() -> int:
    out_path = Path(__file__).parent / "icon.icns"
    entry_bytes = []
    report = []
    for ostype, filename, expected_size in ENTRIES:
        png_path = SRC / filename
        data = png_path.read_bytes()
        w, h = read_png_size(data)
        if w != expected_size or h != expected_size:
            print(f"FATAL: {filename} is {w}x{h}, expected {expected_size}x{expected_size}", file=sys.stderr)
            return 1
        entry_len = 8 + len(data)
        entry_bytes.append(ostype.encode("ascii") + struct.pack(">I", entry_len) + data)
        report.append((ostype, w, len(data)))

    body = b"".join(entry_bytes)
    total_len = 8 + len(body)
    header = b"icns" + struct.pack(">I", total_len)
    out_path.write_bytes(header + body)

    print(f"wrote {out_path} ({total_len} bytes)")
    for ostype, size, n in report:
        print(f"  {ostype}: {size}x{size} px, {n} bytes PNG")
    return 0


if __name__ == "__main__":
    sys.exit(main())
